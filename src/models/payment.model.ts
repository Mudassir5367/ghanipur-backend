import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

const paymentSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    amountMinor: { type: Number, required: true, min: 1 },
    method: { type: String, default: 'CASH' }, // dynamic, validated against ShopSettings
    reference: { type: String, default: '' },
    note: { type: String, default: '' },
    receivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    receivedAt: { type: Date, default: Date.now, index: true },
    reversedAt: { type: Date, default: null },
    reversalOf: { type: Schema.Types.ObjectId, ref: 'Payment', default: null },
  },
  { timestamps: true },
);

paymentSchema.index({ shopId: 1, customerId: 1, receivedAt: -1 });
paymentSchema.index({ shopId: 1, receivedAt: -1 });

export type PaymentDoc = InferSchemaType<typeof paymentSchema> & { _id: Types.ObjectId };

export const Payment = model('Payment', paymentSchema);
