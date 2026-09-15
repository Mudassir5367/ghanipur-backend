import * as productRepo from '../../repositories/dynamo/productRepository.js';
import * as categoryRepo from '../../repositories/dynamo/categoryRepository.js';
import * as unitRepo from '../../repositories/dynamo/unitRepository.js';
import * as userRepo from '../../repositories/dynamo/userRepository.js';
import { conversions, type ConversionRecord } from '../../repositories/dynamo/miscRepositories.js';
import { ApiError } from '../../utils/ApiError.js';
import { parsePagination, paginateInMemory } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import { recordMovement, undoMovements, type MovementResult } from '../../services/inventory.service.js';
import { InventoryTxnType, RefType, CONVERSION_RATE } from '../../constants/inventory.js';
import type { TenantContext } from '../../types/context.js';
import type { CreateConversionInput } from './conversion.validators.js';

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The only conversions the shop makes: Milk → Sweet Milk, Milk → Yogurt. */
export const ConversionOutput = { SWEET_MILK: 'SWEET_MILK', YOGURT: 'YOGURT' } as const;
export type ConversionOutput = (typeof ConversionOutput)[keyof typeof ConversionOutput];
type ConversionRole = 'MILK' | ConversionOutput;

const SWEET_MILK_RE = /sweet\s*milk/i;
const YOGURT_RE = /yog(h)?urt|dahi/i;
const MILK_RE = /milk/i;
// Dairy that mentions milk but isn't drinkable milk to convert (e.g. "Milk Cream").
const NOT_MILK_CATEGORY_RE = /butter|cheese|cream|ghee|lassi/i;

/**
 * Which part a product plays in a conversion, from its name or category. Shops
 * name products freely ("Milk", "Buffalo Milk", "Fresh Dahi"), so this matches
 * the name first and falls back to the category. Sweet Milk is checked before
 * Milk, since its name contains "milk".
 */
export function conversionRole(name: string, categoryName = ''): ConversionRole | null {
  if (SWEET_MILK_RE.test(name)) return ConversionOutput.SWEET_MILK;
  if (YOGURT_RE.test(name) || YOGURT_RE.test(categoryName)) return ConversionOutput.YOGURT;
  if (NOT_MILK_CATEGORY_RE.test(categoryName)) return null;
  if (MILK_RE.test(name) || MILK_RE.test(categoryName)) return 'MILK';
  return null;
}

/**
 * The conversion cost calculation (unchanged). Converting `quantity` of Milk
 * priced at `sourceUnitPriceMinor` at the fixed yield (CONVERSION_RATE = 0.92,
 * i.e. 92 from every 100):
 *  - converted quantity = quantity × 0.92
 *  - converted unit price = proportional, so total value is preserved
 *    (quantity × sourcePrice == convertedQty × convertedPrice)
 * The converted unit price is a cost price for reference only — it is recorded
 * with the conversion and never written to any product's pricing.
 */
export function computeConversion(quantity: number, sourceUnitPriceMinor: number) {
  const convertedQuantity = round3(quantity * CONVERSION_RATE);
  const totalValueMinor = Math.round(quantity * sourceUnitPriceMinor);
  const convertedUnitPriceMinor = convertedQuantity > 0 ? Math.round(totalValueMinor / convertedQuantity) : 0;
  return { rate: CONVERSION_RATE, convertedQuantity, convertedUnitPriceMinor, totalValueMinor };
}

/** Products the conversion form may offer: tracked Milk sources and Sweet Milk / Yogurt outputs. */
export async function conversionOptions(ctx: TenantContext) {
  const [products, cats, units] = await Promise.all([
    productRepo.listByShop(ctx.shopId),
    categoryRepo.listByShop(ctx.shopId),
    unitRepo.listForShop(ctx.shopId),
  ]);
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const unitSymbol = new Map(units.map((u) => [u.id, u.symbol]));

  const milk: ReturnType<typeof option>[] = [];
  const outputs: Record<ConversionOutput, ReturnType<typeof option>[]> = { SWEET_MILK: [], YOGURT: [] };
  function option(p: (typeof products)[number]) {
    return {
      _id: p.id,
      name: p.name,
      currentStock: p.currentStock,
      unitSymbol: unitSymbol.get(p.unitId) ?? '',
      sellingPriceMinor: p.sellingPriceMinor,
    };
  }
  for (const p of products) {
    if (!p.trackInventory) continue; // stock must actually move
    const role = conversionRole(p.name, catName.get(p.categoryId));
    if (role === 'MILK') milk.push(option(p));
    else if (role) outputs[role].push(option(p));
  }
  return { rate: CONVERSION_RATE, milk, outputs };
}

/**
 * Convert Milk into Sweet Milk or Yogurt: deduct the entered Milk quantity from
 * Milk stock, add quantity × 0.92 to the output's stock, and record the
 * conversion with its cost for reference. No product price is changed.
 *
 * The Milk deduction is stock-guarded (can't convert more than you have); if any
 * later step fails, both movements are unwound so stock is never half-converted.
 */
export async function createConversion(ctx: TenantContext, input: CreateConversionInput, userId: string) {
  const [source, target] = await Promise.all([
    productRepo.findById(ctx.shopId, input.sourceProductId),
    productRepo.findById(ctx.shopId, input.targetProductId),
  ]);
  if (!source) throw ApiError.badRequest('Source product not found', 'SOURCE_NOT_FOUND');
  if (!target) throw ApiError.badRequest('Target product not found', 'TARGET_NOT_FOUND');

  const [sourceCat, targetCat] = await Promise.all([
    categoryRepo.findById(ctx.shopId, source.categoryId),
    categoryRepo.findById(ctx.shopId, target.categoryId),
  ]);
  if (conversionRole(source.name, sourceCat?.name) !== 'MILK') {
    throw ApiError.badRequest('Conversion must start from a Milk product', 'SOURCE_NOT_MILK');
  }
  const outputKind = conversionRole(target.name, targetCat?.name);
  if (outputKind !== ConversionOutput.SWEET_MILK && outputKind !== ConversionOutput.YOGURT) {
    throw ApiError.badRequest('Milk can only be converted into Sweet Milk or Yogurt', 'TARGET_NOT_ALLOWED');
  }
  if (!source.trackInventory || !target.trackInventory) {
    throw ApiError.badRequest('Both products must track stock for a conversion', 'PRODUCT_NOT_TRACKED');
  }
  if (source.sellingPriceMinor <= 0) {
    throw ApiError.badRequest('Source product has no price to convert from', 'SOURCE_NO_PRICE');
  }

  const { rate, convertedQuantity, convertedUnitPriceMinor, totalValueMinor } = computeConversion(
    input.quantity,
    source.sellingPriceMinor,
  );
  const [sourceUnit, targetUnit] = await Promise.all([
    unitRepo.findUsable(ctx.shopId, source.unitId),
    unitRepo.findUsable(ctx.shopId, target.unitId),
  ]);

  const undos: NonNullable<MovementResult['undo']>[] = [];
  try {
    // Deduct the entered Milk quantity (stock-guarded).
    const out = await recordMovement(ctx, {
      productId: source.id,
      type: InventoryTxnType.CONVERSION_OUT,
      quantity: input.quantity,
      refType: RefType.PRODUCT,
      refId: target.id,
      performedBy: userId,
      note: `Converted to ${target.name}`,
    });
    if (out.undo) undos.push(out.undo);

    // Add the 92% yield to the output product.
    const inMove = await recordMovement(ctx, {
      productId: target.id,
      type: InventoryTxnType.CONVERSION_IN,
      quantity: convertedQuantity,
      refType: RefType.PRODUCT,
      refId: source.id,
      performedBy: userId,
      note: `Converted from ${source.name}`,
    });
    if (inMove.undo) undos.push(inMove.undo);

    return await conversions.create({
      shopId: ctx.shopId,
      sourceProductId: source.id,
      sourceName: source.name,
      targetProductId: target.id,
      targetName: target.name,
      unitSymbol: sourceUnit?.symbol ?? '',
      targetUnitSymbol: targetUnit?.symbol ?? '',
      outputKind,
      rate,
      sourceQuantity: input.quantity,
      convertedQuantity,
      sourceUnitPriceMinor: source.sellingPriceMinor,
      convertedUnitPriceMinor,
      totalValueMinor,
      performedBy: userId,
    });
  } catch (err) {
    await undoMovements(ctx, undos);
    throw err;
  }
}

/** Parses an optional ISO date bound; a malformed value is a client error, not "no filter". */
function parseBound(value: unknown, field: string): number | null {
  if (value === undefined || value === '') return null;
  const t = new Date(String(value)).getTime();
  if (Number.isNaN(t)) throw ApiError.badRequest(`Invalid ${field} date`, 'INVALID_DATE');
  return t;
}

async function conversionsInRange(ctx: TenantContext, query: Record<string, unknown>): Promise<ConversionRecord[]> {
  const from = parseBound(query.from, 'from');
  const to = parseBound(query.to, 'to');
  const rows = await conversions.listByShop(ctx.shopId);
  return rows.filter((r) => {
    const t = new Date(r.createdAt).getTime();
    return (from === null || t >= from) && (to === null || t <= to);
  });
}

/** Older records predate outputKind; derive it from the name they were saved with. */
function outputKindOf(r: ConversionRecord): string {
  return r.outputKind ?? conversionRole(r.targetName) ?? 'OTHER';
}

export async function listConversions(ctx: TenantContext, query: Record<string, unknown>) {
  const { page, limit, skip, sort } = parsePagination(query, '-createdAt');
  const rows = await conversionsInRange(ctx, query);
  const { data, total } = paginateInMemory(rows, { skip, limit, sort });

  // Who made each conversion, for the store team's history — one lookup per person.
  const actorIds = [...new Set(data.map((r) => r.performedBy).filter((v): v is string => !!v))];
  const actors = await Promise.all(actorIds.map((id) => userRepo.findById(id)));
  const nameById = new Map(actors.filter((u) => u !== null).map((u) => [u.id, u.name]));

  return {
    data: data.map((r) => ({
      ...r,
      outputKind: outputKindOf(r),
      targetUnitSymbol: r.targetUnitSymbol ?? r.unitSymbol,
      performedByName: r.performedBy ? (nameById.get(r.performedBy) ?? null) : null,
    })),
    meta: buildPageMeta(page, limit, total),
  };
}

/** Totals for a period (daily / weekly / monthly history): Milk used, output made, cost. */
export async function conversionSummary(ctx: TenantContext, query: Record<string, unknown>) {
  const rows = await conversionsInRange(ctx, query);
  const milkUsed = new Map<string, number>();
  const produced = new Map<string, { outputKind: string; unitSymbol: string; quantity: number }>();
  let totalCostMinor = 0;

  for (const r of rows) {
    milkUsed.set(r.unitSymbol, round3((milkUsed.get(r.unitSymbol) ?? 0) + r.sourceQuantity));
    const kind = outputKindOf(r);
    const unit = r.targetUnitSymbol ?? r.unitSymbol;
    const key = `${kind}|${unit}`;
    const cur = produced.get(key) ?? { outputKind: kind, unitSymbol: unit, quantity: 0 };
    cur.quantity = round3(cur.quantity + r.convertedQuantity);
    produced.set(key, cur);
    totalCostMinor += r.totalValueMinor;
  }

  return {
    count: rows.length,
    milkUsed: [...milkUsed].map(([unitSymbol, quantity]) => ({ unitSymbol, quantity })),
    produced: [...produced.values()],
    totalCostMinor,
  };
}
