import { Schema, model, type InferSchemaType, type Types, type HydratedDocument } from 'mongoose';

export const CategoryStatus = { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' } as const;

const categorySchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, default: '' },
    image: { type: String, default: null },
    icon: { type: String, default: null },
    parentId: { type: Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: Object.values(CategoryStatus), default: CategoryStatus.ACTIVE },
    seoTitle: { type: String, default: '' },
    seoDescription: { type: String, default: '' },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// Unique slug per shop (excluding soft-deleted handled at app level).
categorySchema.index({ shopId: 1, slug: 1 }, { unique: true });
categorySchema.index({ shopId: 1, parentId: 1, sortOrder: 1 });

export type CategoryDoc = InferSchemaType<typeof categorySchema> & { _id: Types.ObjectId };
export type CategoryHydrated = HydratedDocument<InferSchemaType<typeof categorySchema>>;

export const Category = model('Category', categorySchema);
