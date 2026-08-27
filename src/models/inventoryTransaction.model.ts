import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { InventoryTxnType, RefType } from '../constants/inventory.js';

/** Append-only inventory ledger (§9). Never updated or deleted after creation. */
const inventoryTransactionSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    type: { type: String, enum: Object.values(InventoryTxnType), required: true },
    // Signed quantity: negative removes stock, positive adds. Balance is derivable.
    quantity: { type: Number, required: true },
    unitId: { type: Schema.Types.ObjectId, ref: 'Unit', required: true },
    balanceAfter: { type: Number, required: true },
    refType: { type: String, enum: Object.values(RefType), default: RefType.MANUAL },
    refId: { type: Schema.Types.ObjectId, default: null },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '' },
    occurredAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

inventoryTransactionSchema.index({ shopId: 1, productId: 1, occurredAt: -1 });
inventoryTransactionSchema.index({ shopId: 1, type: 1, occurredAt: -1 });
inventoryTransactionSchema.index({ refType: 1, refId: 1 });

export type InventoryTransactionDoc = InferSchemaType<typeof inventoryTransactionSchema> & { _id: Types.ObjectId };

export const InventoryTransaction = model('InventoryTransaction', inventoryTransactionSchema);
