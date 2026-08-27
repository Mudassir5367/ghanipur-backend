import { Schema, model, type InferSchemaType, type Types, type HydratedDocument } from 'mongoose';
import { ROLES, Role } from '../constants/roles.js';

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    phone: { type: String, trim: true },
    passwordHash: { type: String, required: true, select: false },
    avatarUrl: { type: String, default: null }, // profile picture URL (optional)
    role: { type: String, enum: ROLES, required: true, default: Role.SHOP_ADMIN },
    // Shop-scoped roles carry a shopId; SUPER_ADMIN / USER do not.
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', default: null, index: true },
    // Per-user permission overrides on top of role defaults.
    permissions: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
    emailVerifiedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    // Hash of current refresh token; rotating this invalidates old sessions.
    refreshTokenHash: { type: String, default: null, select: false },
  },
  { timestamps: true },
);

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
export type UserHydrated = HydratedDocument<InferSchemaType<typeof userSchema>>;

export const User = model('User', userSchema);
