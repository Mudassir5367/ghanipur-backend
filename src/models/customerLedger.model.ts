import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { LedgerEntryType, LedgerRefType } from '../constants/sales.js';

/** Append-only customer ledger (§13, §37). Never mutated; corrections are new entries. */
const customerLedgerSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    entryType: { type: String, enum: Object.values(LedgerEntryType), required: true },
    debitMinor: { type: Number, default: 0 }, // increases what the customer owes
    creditMinor: { type: Number, default: 0 }, // decreases what the customer owes
    balanceAfterMinor: { type: Number, required: true },
    refType: { type: String, enum: Object.values(LedgerRefType), default: LedgerRefType.MANUAL },
    refId: { type: Schema.Types.ObjectId, default: null },
    note: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    occurredAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

customerLedgerSchema.index({ shopId: 1, customerId: 1, occurredAt: -1 });
customerLedgerSchema.index({ refType: 1, refId: 1 });

export type CustomerLedgerDoc = InferSchemaType<typeof customerLedgerSchema> & { _id: Types.ObjectId };

export const CustomerLedger = model('CustomerLedger', customerLedgerSchema);
