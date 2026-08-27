import { Schema, model, type InferSchemaType, type Types, type HydratedDocument } from 'mongoose';

export const ProductStatus = { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' } as const;

const productSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    name: { type: String, required: true, trim: true },
    sku: { type: String, required: true, trim: true },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, default: '' },
    images: { type: [String], default: [] },

    unitId: { type: Schema.Types.ObjectId, ref: 'Unit', required: true },
    unitValue: { type: Number, default: 1 }, // e.g. a "1 Litre" pack => unitValue 1

    purchaseCostMinor: { type: Number, default: 0, min: 0 },
    sellingPriceMinor: { type: Number, required: true, min: 0 },
    taxConfig: {
      rate: { type: Number, default: 0 }, // percent
      inclusive: { type: Boolean, default: true },
    },

    minStock: { type: Number, default: 0 },
    // Cached ledger balance — mutated ONLY via atomic $inc inside inventory txns (§9).
    currentStock: { type: Number, default: 0 },
    trackInventory: { type: Boolean, default: true },

    isAvailable: { type: Boolean, default: true },
    deliveryAvailable: { type: Boolean, default: true },
    status: { type: String, enum: Object.values(ProductStatus), default: ProductStatus.ACTIVE },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

productSchema.index({ shopId: 1, slug: 1 }, { unique: true });
productSchema.index({ shopId: 1, sku: 1 }, { unique: true });
productSchema.index({ shopId: 1, categoryId: 1 });
productSchema.index({ shopId: 1, status: 1, isAvailable: 1 });

export type ProductDoc = InferSchemaType<typeof productSchema> & { _id: Types.ObjectId };
export type ProductHydrated = HydratedDocument<InferSchemaType<typeof productSchema>>;

export const Product = model('Product', productSchema);
