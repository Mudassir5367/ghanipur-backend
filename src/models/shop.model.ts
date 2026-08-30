import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

export const ShopStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  INACTIVE: 'INACTIVE',
} as const;
export type ShopStatus = (typeof ShopStatus)[keyof typeof ShopStatus];

const shopSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    logo: { type: String, default: null },
    banner: { type: String, default: null },
    description: { type: String, default: '' },

    phone: { type: String, trim: true },
    whatsapp: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },

    address: {
      line: { type: String, default: '' },
      city: { type: String, default: '' },
      area: { type: String, default: '' },
      geo: { lat: { type: Number }, lng: { type: Number } },
    },

    businessHours: { type: Schema.Types.Mixed, default: {} },
    socialLinks: { type: Schema.Types.Mixed, default: {} },

    timezone: { type: String, default: 'Asia/Karachi' },
    currency: { type: String, default: 'PKR' },

    deliverySettings: {
      enabled: { type: Boolean, default: true },
      feeMinor: { type: Number, default: 0 },
      minOrderMinor: { type: Number, default: 0 },
      radiusKm: { type: Number, default: 0 },
    },

    status: { type: String, enum: Object.values(ShopStatus), default: ShopStatus.PENDING, index: true },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

shopSchema.index({ status: 1, isDeleted: 1 });
// One shop per owner (admin): a hard DB guarantee for the "an admin can create only
// one shop" rule, alongside the service check (createMyShop) and UI redirect. Partial
// so a soft-deleted shop never permanently blocks the owner from creating a new one.
shopSchema.index({ ownerId: 1 }, { unique: true, partialFilterExpression: { isDeleted: false }, name: 'ownerId_unique_active' });

export type ShopDoc = InferSchemaType<typeof shopSchema> & { _id: Types.ObjectId };

export const Shop = model('Shop', shopSchema);
