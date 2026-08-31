import { TABLES } from '../../config/dynamoTables.js';
import {
  compositeKey,
  deleteItem,
  getItem,
  putItem,
  queryAllByPartition,
  timeKey,
  updateItem,
  withLegacyId,
} from './base.js';
import { newId } from './id.js';

/**
 * The smaller DynamoDB stores, grouped because each is a handful of operations
 * over one table: Expense, Conversion, AuditLog and PasswordReset.
 */

// ---------------------------------------------------------------- Expense ----

export interface ExpenseRecord {
  shopId: string;
  sk: string;
  id: string;
  _id?: string;
  shopCategoryKey: string;
  category: string;
  amountMinor: number;
  method: string;
  description: string;
  isRecurring: boolean;
  incurredAt: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const EXPENSES = TABLES.Expense as string;

export const expenses = {
  async create(input: {
    shopId: string;
    category: string;
    amountMinor: number;
    method?: string;
    description?: string;
    isRecurring?: boolean;
    incurredAt?: Date;
    createdBy?: string | null;
  }): Promise<ExpenseRecord> {
    const id = newId();
    const incurredAt = (input.incurredAt ?? new Date()).toISOString();
    const now = new Date().toISOString();
    const record: ExpenseRecord = {
      shopId: input.shopId,
      sk: timeKey(incurredAt, id),
      id,
      shopCategoryKey: compositeKey(input.shopId, input.category),
      category: input.category,
      amountMinor: input.amountMinor,
      method: input.method ?? 'CASH',
      description: input.description ?? '',
      isRecurring: input.isRecurring ?? false,
      incurredAt,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await putItem(EXPENSES, record);
    return withLegacyId(record);
  },

  async listByShop(shopId: string): Promise<ExpenseRecord[]> {
    const rows = await queryAllByPartition<ExpenseRecord>(EXPENSES, 'shopId', shopId);
    return rows.map((r) => withLegacyId(r));
  },

  async findScoped(shopId: string, id: string): Promise<ExpenseRecord | null> {
    return (await this.listByShop(shopId)).find((e) => e.id === id) ?? null;
  },

  async update(
    expense: ExpenseRecord,
    patch: Partial<Pick<ExpenseRecord, 'category' | 'amountMinor' | 'method' | 'description' | 'isRecurring'>>,
  ): Promise<ExpenseRecord> {
    const next: Record<string, unknown> = { ...patch, updatedAt: new Date().toISOString() };
    if (patch.category !== undefined) next.shopCategoryKey = compositeKey(expense.shopId, patch.category);
    await updateItem(EXPENSES, { shopId: expense.shopId, sk: expense.sk }, next);
    return withLegacyId({ ...expense, ...next } as ExpenseRecord);
  },

  async remove(expense: Pick<ExpenseRecord, 'shopId' | 'sk'>): Promise<void> {
    await deleteItem(EXPENSES, { shopId: expense.shopId, sk: expense.sk });
  },
};

// ------------------------------------------------------------- Conversion ----

export interface ConversionRecord {
  shopId: string;
  sk: string;
  id: string;
  _id?: string;
  sourceProductId: string;
  sourceName: string;
  targetProductId: string;
  targetName: string;
  unitSymbol: string;
  rate: number;
  sourceQuantity: number;
  convertedQuantity: number;
  sourceUnitPriceMinor: number;
  convertedUnitPriceMinor: number;
  totalValueMinor: number;
  performedBy: string | null;
  createdAt: string;
}

const CONVERSIONS = TABLES.Conversion as string;

export const conversions = {
  /** Immutable history — the real stock movement lives in the inventory ledger. */
  async create(input: Omit<ConversionRecord, 'shopId' | 'sk' | 'id' | '_id' | 'createdAt'> & { shopId: string }): Promise<ConversionRecord> {
    const id = newId();
    const createdAt = new Date().toISOString();
    const record: ConversionRecord = { ...input, id, sk: timeKey(createdAt, id), createdAt };
    await putItem(CONVERSIONS, record);
    return withLegacyId(record);
  },

  async listByShop(shopId: string): Promise<ConversionRecord[]> {
    const rows = await queryAllByPartition<ConversionRecord>(CONVERSIONS, 'shopId', shopId);
    return rows.map((r) => withLegacyId(r));
  },
};

// --------------------------------------------------------------- AuditLog ----

export interface AuditLogRecord {
  shopKey: string;
  sk: string;
  id: string;
  _id?: string;
  resourceKey: string;
  actorId: string | null;
  actorRole: string | null;
  shopId: string | null;
  action: string;
  resource: string | null;
  resourceId: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

const AUDIT = TABLES.AuditLog as string;
const PLATFORM = 'PLATFORM';

export const auditLogs = {
  /** Platform-level events (no shop) live under the literal "PLATFORM" partition,
   *  since DynamoDB cannot have a null partition key. */
  async append(input: {
    actorId?: string | null;
    actorRole?: string | null;
    shopId?: string | null;
    action: string;
    resource?: string | null;
    resourceId?: string | null;
    ip?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<AuditLogRecord> {
    const id = newId();
    const createdAt = new Date().toISOString();
    const record: AuditLogRecord = {
      shopKey: input.shopId ?? PLATFORM,
      sk: timeKey(createdAt, id),
      id,
      resourceKey: compositeKey(input.resource ?? 'NONE', input.resourceId ?? 'NONE'),
      actorId: input.actorId ?? null,
      actorRole: input.actorRole ?? null,
      shopId: input.shopId ?? null,
      action: input.action,
      resource: input.resource ?? null,
      resourceId: input.resourceId ?? null,
      ip: input.ip ?? null,
      metadata: input.metadata ?? {},
      createdAt,
    };
    await putItem(AUDIT, record);
    return withLegacyId(record);
  },

  async listByShop(shopId: string | null): Promise<AuditLogRecord[]> {
    const rows = await queryAllByPartition<AuditLogRecord>(AUDIT, 'shopKey', shopId ?? PLATFORM);
    return rows.map((r) => withLegacyId(r));
  },
};

// ---------------------------------------------------------- PasswordReset ----

export interface PasswordResetRecord {
  email: string;
  sk: 'RESET';
  otpHash: string;
  resetTokenHash: string | null;
  expiresAt: string;
  attempts: number;
  lastSentAt: string;
  verifiedAt: string | null;
  /** Epoch seconds for DynamoDB's native TTL — replaces the Mongo TTL index. */
  ttl: number;
  createdAt: string;
  updatedAt: string;
}

const RESETS = TABLES.PasswordReset as string;
const RESET_TTL_SECONDS = 24 * 60 * 60;

export const passwordResets = {
  async find(email: string): Promise<PasswordResetRecord | null> {
    return getItem<PasswordResetRecord>(RESETS, { email: email.toLowerCase(), sk: 'RESET' });
  },

  /** One active reset per email — an upsert, matching the old unique-per-email row. */
  async upsert(email: string, fields: Omit<PasswordResetRecord, 'email' | 'sk' | 'ttl' | 'createdAt' | 'updatedAt'>): Promise<PasswordResetRecord> {
    const now = new Date();
    const record: PasswordResetRecord = {
      email: email.toLowerCase(),
      sk: 'RESET',
      ...fields,
      ttl: Math.floor(now.getTime() / 1000) + RESET_TTL_SECONDS,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await putItem(RESETS, record);
    return record;
  },

  async patch(email: string, fields: Partial<Omit<PasswordResetRecord, 'email' | 'sk'>>): Promise<void> {
    await updateItem(RESETS, { email: email.toLowerCase(), sk: 'RESET' }, { ...fields, updatedAt: new Date().toISOString() });
  },

  async remove(email: string): Promise<void> {
    await deleteItem(RESETS, { email: email.toLowerCase(), sk: 'RESET' });
  },
};
