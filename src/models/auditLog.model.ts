import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    actorRole: { type: String, default: null },
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', default: null, index: true },
    action: { type: String, required: true }, // e.g. AUTH_LOGIN, SALE_CREATE
    resource: { type: String, default: null }, // e.g. Sale
    resourceId: { type: Schema.Types.ObjectId, default: null },
    ip: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ shopId: 1, createdAt: -1 });
auditLogSchema.index({ resource: 1, resourceId: 1 });

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema> & { _id: Types.ObjectId };

export const AuditLog = model('AuditLog', auditLogSchema);
