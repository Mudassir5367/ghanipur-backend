import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

const saleItemSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    name: { type: String, required: true }, // snapshot at time of sale
    quantity: { type: Number, required: true },
    unitId: { type: Schema.Types.ObjectId, ref: 'Unit', required: true },
    unitPriceMinor: { type: Number, required: true },
    lineTotalMinor: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

saleItemSchema.index({ shopId: 1, saleId: 1 });
saleItemSchema.index({ shopId: 1, productId: 1 });

export type SaleItemDoc = InferSchemaType<typeof saleItemSchema> & { _id: Types.ObjectId };

export const SaleItem = model('SaleItem', saleItemSchema);
