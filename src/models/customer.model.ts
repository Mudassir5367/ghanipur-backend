import { Schema, model, type InferSchemaType, type Types, type HydratedDocument } from 'mongoose';

export const CustomerStatus = { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' } as const;

const customerSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    altPhone: { type: String, trim: true },
    address: { type: String, default: '' },
    // Dynamic type string validated against ShopSettings.customerTypes (§11).
    type: { type: String, default: 'INDIVIDUAL' },
    notes: { type: String, default: '' },
    status: { type: String, enum: Object.values(CustomerStatus), default: CustomerStatus.ACTIVE },

    creditLimitMinor: { type: Number, default: 0 },
    openingBalanceMinor: { type: Number, default: 0 },
    // Cached running balance (positive = customer owes the shop). Ledger is truth (§13).
    currentBalanceMinor: { type: Number, default: 0 },

    lastSaleAt: { type: Date, default: null },
    lastPaymentAt: { type: Date, default: null },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

customerSchema.index({ shopId: 1, phone: 1 });
customerSchema.index({ shopId: 1, status: 1 });
customerSchema.index({ shopId: 1, name: 'text', phone: 'text' });

export type CustomerDoc = InferSchemaType<typeof customerSchema> & { _id: Types.ObjectId };
export type CustomerHydrated = HydratedDocument<InferSchemaType<typeof customerSchema>>;

export const Customer = model('Customer', customerSchema);
