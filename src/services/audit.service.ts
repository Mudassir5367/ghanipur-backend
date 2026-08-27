import type { Types } from 'mongoose';
import { AuditLog } from '../models/auditLog.model.js';
import { logger } from '../config/logger.js';

export interface AuditInput {
  actorId?: Types.ObjectId | string | null;
  actorRole?: string | null;
  shopId?: Types.ObjectId | string | null;
  action: string;
  resource?: string | null;
  resourceId?: Types.ObjectId | string | null;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Fire-and-forget audit trail (§38). Never throws into the request path —
 * a failed audit write must not break the user's action, but is logged.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await AuditLog.create({
      actorId: input.actorId ?? null,
      actorRole: input.actorRole ?? null,
      shopId: input.shopId ?? null,
      action: input.action,
      resource: input.resource ?? null,
      resourceId: input.resourceId ?? null,
      ip: input.ip ?? null,
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'Failed to write audit log');
  }
}
