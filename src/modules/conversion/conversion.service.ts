import * as productRepo from '../../repositories/dynamo/productRepository.js';
import * as unitRepo from '../../repositories/dynamo/unitRepository.js';
import { conversions } from '../../repositories/dynamo/miscRepositories.js';
import { ApiError } from '../../utils/ApiError.js';
import { parsePagination, paginateInMemory } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import { recordMovement, undoMovements, type MovementResult } from '../../services/inventory.service.js';
import { InventoryTxnType, RefType, CONVERSION_RATE } from '../../constants/inventory.js';
import type { TenantContext } from '../../types/context.js';
import type { CreateConversionInput } from './conversion.validators.js';

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Compute the result of converting `quantity` of a source product priced at
 * `sourceUnitPriceMinor` at the fixed yield (§ CONVERSION_RATE = 0.96):
 *  - converted quantity = quantity × 0.96
 *  - converted unit price = proportional so total value is preserved
 *    (quantity × sourcePrice == convertedQty × convertedPrice)
 */
export function computeConversion(quantity: number, sourceUnitPriceMinor: number) {
  const convertedQuantity = round3(quantity * CONVERSION_RATE);
  const totalValueMinor = Math.round(quantity * sourceUnitPriceMinor);
  const convertedUnitPriceMinor = convertedQuantity > 0 ? Math.round(totalValueMinor / convertedQuantity) : 0;
  return { rate: CONVERSION_RATE, convertedQuantity, convertedUnitPriceMinor, totalValueMinor };
}

/**
 * Convert stock from one product into another (Milk → Sweet Milk / Yogurt):
 * consume the source, produce the converted quantity, reprice the target so total
 * value is preserved, and record the conversion.
 *
 * This was one Mongo transaction. The source deduction is still stock-guarded, so
 * you cannot convert more than you have; if any later step fails, both movements
 * are unwound so stock is never left half-converted.
 */
export async function createConversion(ctx: TenantContext, input: CreateConversionInput, userId: string) {
  const [source, target] = await Promise.all([
    productRepo.findById(ctx.shopId, input.sourceProductId),
    productRepo.findById(ctx.shopId, input.targetProductId),
  ]);
  if (!source) throw ApiError.badRequest('Source product not found', 'SOURCE_NOT_FOUND');
  if (!target) throw ApiError.badRequest('Target product not found', 'TARGET_NOT_FOUND');
  if (source.sellingPriceMinor <= 0) {
    throw ApiError.badRequest('Source product has no price to convert from', 'SOURCE_NO_PRICE');
  }

  const { rate, convertedQuantity, convertedUnitPriceMinor, totalValueMinor } = computeConversion(
    input.quantity,
    source.sellingPriceMinor,
  );
  const unit = await unitRepo.findUsable(ctx.shopId, source.unitId);
  const unitSymbol = unit?.symbol ?? '';

  const undos: NonNullable<MovementResult['undo']>[] = [];
  try {
    // Consume the source (stock-guarded: can't convert more than you have).
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

    // Produce the converted product.
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

    // Keep the price consistent everywhere: the target now reflects the proportional price.
    await productRepo.update(ctx.shopId, target.id, { sellingPriceMinor: convertedUnitPriceMinor });

    return await conversions.create({
      shopId: ctx.shopId,
      sourceProductId: source.id,
      sourceName: source.name,
      targetProductId: target.id,
      targetName: target.name,
      unitSymbol,
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

export async function listConversions(ctx: TenantContext, query: unknown) {
  const { page, limit, skip, sort } = parsePagination(query, '-createdAt');
  const rows = await conversions.listByShop(ctx.shopId);
  const { data, total } = paginateInMemory(rows, { skip, limit, sort });
  return { data, meta: buildPageMeta(page, limit, total) };
}
