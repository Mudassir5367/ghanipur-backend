import { Unit, DEFAULT_UNITS, UnitKind } from '../../models/unit.model.js';
import { ApiError } from '../../utils/ApiError.js';
import type { TenantContext } from '../../types/context.js';

/** Idempotently ensure the platform-shared units exist (shopId=null). */
export async function ensureDefaultUnits(): Promise<void> {
  const ops = DEFAULT_UNITS.map((u) => ({
    updateOne: {
      filter: { shopId: null, symbol: u.symbol },
      update: { $setOnInsert: { ...u, shopId: null, isShared: true } },
      upsert: true,
    },
  }));
  await Unit.bulkWrite(ops);
}

export async function listUnits(ctx: TenantContext) {
  // Keyed off DB state (not an in-memory flag) so it self-heals a fresh database.
  if (!(await Unit.exists({ isShared: true }))) await ensureDefaultUnits();
  return Unit.find({ $or: [{ shopId: null }, { shopId: ctx.shopId }] }).sort({ isShared: -1, name: 1 });
}

export async function createUnit(
  ctx: TenantContext,
  input: { name: string; symbol: string; kind?: UnitKind; allowsDecimal?: boolean },
) {
  const exists = await Unit.exists({ shopId: ctx.shopId, symbol: input.symbol });
  if (exists) throw ApiError.conflict('A unit with this symbol already exists', 'UNIT_EXISTS');
  return Unit.create({
    shopId: ctx.shopId,
    name: input.name,
    symbol: input.symbol,
    kind: input.kind ?? UnitKind.CUSTOM,
    allowsDecimal: input.allowsDecimal ?? true,
    isShared: false,
  });
}

/** Validate a unit is usable by this shop (shared or its own). Used by products. */
export async function assertUsableUnit(ctx: TenantContext, unitId: string): Promise<void> {
  const unit = await Unit.findOne({ _id: unitId, $or: [{ shopId: null }, { shopId: ctx.shopId }] });
  if (!unit) throw ApiError.badRequest('Invalid unit', 'INVALID_UNIT');
}
