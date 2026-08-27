import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

/** Default configurable lists a new shop starts with (all editable — §5, §11, §14). */
export const DEFAULT_PAYMENT_METHODS = ['CASH', 'BANK', 'EASYPAISA', 'JAZZCASH', 'CARD', 'OTHER'];
export const DEFAULT_CUSTOMER_TYPES = ['INDIVIDUAL', 'HOUSEHOLD', 'HOTEL', 'RESTAURANT', 'BUSINESS', 'OTHER'];

const shopSettingsSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, unique: true, index: true },
    paymentMethods: { type: [String], default: DEFAULT_PAYMENT_METHODS },
    customerTypes: { type: [String], default: DEFAULT_CUSTOMER_TYPES },
    locale: { type: String, default: 'en' },
    theme: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

export type ShopSettingsDoc = InferSchemaType<typeof shopSettingsSchema> & { _id: Types.ObjectId };

export const ShopSettings = model('ShopSettings', shopSettingsSchema);
