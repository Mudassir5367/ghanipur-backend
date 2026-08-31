import { auditLogs } from '../repositories/dynamo/miscRepositories.js';
import { logger } from '../config/logger.js';

export interface AuditInput {
  actorId?: string | null;
  actorRole?: string | null;
  shopId?: string | null;
  action: string;
  resource?: string | null;
  resourceId?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Fire-and-forget audit trail (§38). Never throws into the request path —
 * a failed audit write must not break the user's action, but is logged.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await auditLogs.append({
      actorId: input.actorId ? String(input.actorId) : null,
      actorRole: input.actorRole ?? null,
      shopId: input.shopId ? String(input.shopId) : null,
      action: input.action,
      resource: input.resource ?? null,
      resourceId: input.resourceId ? String(input.resourceId) : null,
      ip: input.ip ?? null,
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'Failed to write audit log');
  }
}
