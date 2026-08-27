import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { SaleType, SaleStatus } from '../constants/sales.js';

const saleSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
    code: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null, index: true }, // null = walk-in cash
    customerPhone: { type: String, trim: true, default: '' }, // optional phone for a walk-in (no customer record)
    type: { type: String, enum: Object.values(SaleType), required: true },
    status: { type: String, enum: Object.values(SaleStatus), default: SaleStatus.COMPLETED, index: true },

    subtotalMinor: { type: Number, required: true },
    taxMinor: { type: Number, default: 0 },
    totalMinor: { type: Number, required: true },
    paidMinor: { type: Number, default: 0 },
    dueMinor: { type: Number, default: 0 },

    paymentMethod: { type: String, default: null }, // for cash sales
    note: { type: String, default: '' },
    soldBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    soldAt: { type: Date, default: Date.now, index: true },

    // Immutability: cancellation is a reversal, not an edit (§79).
    reversalOf: { type: Schema.Types.ObjectId, ref: 'Sale', default: null },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

saleSchema.index({ shopId: 1, code: 1 }, { unique: true });
saleSchema.index({ shopId: 1, soldAt: -1 });
saleSchema.index({ shopId: 1, customerId: 1, soldAt: -1 });
saleSchema.index({ shopId: 1, type: 1, soldAt: -1 });

export type SaleDoc = InferSchemaType<typeof saleSchema> & { _id: Types.ObjectId };

export const Sale = model('Sale', saleSchema);
