import { Product } from '../../models/product.model.js';
import { Conversion } from '../../models/conversion.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { withTransaction } from '../../utils/withTransaction.js';
import { parsePagination } from '../../utils/pagination.js';
import { buildPageMeta } from '../../utils/http.js';
import { recordMovement } from '../../services/inventory.service.js';
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
 * Convert stock from one product into another (Milk → Sweet Milk / Yogurt).
 * Atomically: consume the source quantity, produce the converted quantity, set the
 * target's selling price to the proportional value, and record the conversion.
 */
export async function createConversion(ctx: TenantContext, input: CreateConversionInput, userId: string) {
  const [source, target] = await Promise.all([
    Product.findOne({ _id: input.sourceProductId, shopId: ctx.shopId, isDeleted: false }).populate('unitId', 'symbol'),
    Product.findOne({ _id: input.targetProductId, shopId: ctx.shopId, isDeleted: false }),
  ]);
  if (!source) throw ApiError.badRequest('Source product not found', 'SOURCE_NOT_FOUND');
  if (!target) throw ApiError.badRequest('Target product not found', 'TARGET_NOT_FOUND');
  if (source.sellingPriceMinor <= 0) throw ApiError.badRequest('Source product has no price to convert from', 'SOURCE_NO_PRICE');

  const { rate, convertedQuantity, convertedUnitPriceMinor, totalValueMinor } = computeConversion(input.quantity, source.sellingPriceMinor);
  const unitSymbol = (source.unitId as unknown as { symbol?: string })?.symbol ?? '';

  return withTransaction(async (session) => {
    // Consume the source (stock-guarded: can't convert more than you have).
    await recordMovement(
      ctx,
      { productId: source._id.toString(), type: InventoryTxnType.CONVERSION_OUT, quantity: input.quantity, refType: RefType.PRODUCT, refId: target._id, performedBy: userId, note: `Converted to ${target.name}` },
      session,
    );
    // Produce the converted product.
    await recordMovement(
      ctx,
      { productId: target._id.toString(), type: InventoryTxnType.CONVERSION_IN, quantity: convertedQuantity, refType: RefType.PRODUCT, refId: source._id, performedBy: userId, note: `Converted from ${source.name}` },
      session,
    );
    // Keep the price consistent everywhere: the target now reflects the proportional price.
    await Product.updateOne({ _id: target._id, shopId: ctx.shopId }, { sellingPriceMinor: convertedUnitPriceMinor }, { session });

    const [conversion] = await Conversion.create(
      [{
        shopId: ctx.shopId,
        sourceProductId: source._id,
        sourceName: source.name,
        targetProductId: target._id,
        targetName: target.name,
        unitSymbol,
        rate,
        sourceQuantity: input.quantity,
        convertedQuantity,
        sourceUnitPriceMinor: source.sellingPriceMinor,
        convertedUnitPriceMinor,
        totalValueMinor,
        performedBy: userId,
      }],
      { session, ordered: true },
    );
    return conversion!;
  });
}

export async function listConversions(ctx: TenantContext, query: unknown) {
  const { page, limit, skip } = parsePagination(query, '-createdAt');
  const filter = { shopId: ctx.shopId };
  const [data, total] = await Promise.all([
    Conversion.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Conversion.countDocuments(filter),
  ]);
  return { data, meta: buildPageMeta(page, limit, total) };
}
