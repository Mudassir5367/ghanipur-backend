import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

/**
 * Record of a stock conversion (e.g. Milk → Yogurt / Sweet Milk). Immutable history:
 * the actual stock moves live in the inventory ledger; this row keeps the business
 * summary (quantities, rate, prices) for the Conversions tab.
 */
const conversionSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },

    sourceProductId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    sourceName: { type: String, required: true }, // snapshot
    targetProductId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    targetName: { type: String, required: true }, // snapshot
    unitSymbol: { type: String, default: '' },

    rate: { type: Number, required: true }, // e.g. 0.96
    sourceQuantity: { type: Number, required: true },
    convertedQuantity: { type: Number, required: true },

    sourceUnitPriceMinor: { type: Number, required: true },
    convertedUnitPriceMinor: { type: Number, required: true },
    totalValueMinor: { type: Number, required: true }, // preserved across the conversion

    performedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

conversionSchema.index({ shopId: 1, createdAt: -1 });

export type ConversionDoc = InferSchemaType<typeof conversionSchema> & { _id: Types.ObjectId };

export const Conversion = model('Conversion', conversionSchema);
