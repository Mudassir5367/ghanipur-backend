import * as unitRepo from '../../repositories/dynamo/unitRepository.js';
import { UnitKind } from '../../repositories/dynamo/unitRepository.js';
import { UniqueConstraintError } from '../../repositories/dynamo/base.js';
import { ApiError } from '../../utils/ApiError.js';
import type { TenantContext } from '../../types/context.js';

export { UnitKind };

/** The platform-shared units every shop starts with (§7). */
export const DEFAULT_UNITS = [
  { name: 'Litre', symbol: 'L', kind: UnitKind.VOLUME, allowsDecimal: true },
  { name: 'Millilitre', symbol: 'ml', kind: UnitKind.VOLUME, allowsDecimal: true },
  { name: 'Kilogram', symbol: 'kg', kind: UnitKind.WEIGHT, allowsDecimal: true },
  { name: 'Gram', symbol: 'g', kind: UnitKind.WEIGHT, allowsDecimal: true },
  { name: 'Piece', symbol: 'pc', kind: UnitKind.COUNT, allowsDecimal: false },
  { name: 'Packet', symbol: 'pkt', kind: UnitKind.COUNT, allowsDecimal: false },
  { name: 'Box', symbol: 'box', kind: UnitKind.COUNT, allowsDecimal: false },
  { name: 'Bottle', symbol: 'btl', kind: UnitKind.COUNT, allowsDecimal: false },
] as const;

/**
 * Idempotently ensure the platform-shared units exist.
 *
 * Mongo did this with a bulk upsert; DynamoDB has no upsert-many, so each unit
 * is created and a symbol-guard rejection is treated as "already there". That
 * makes concurrent callers safe: the loser sees the conflict and moves on.
 */
export async function ensureDefaultUnits(): Promise<void> {
  for (const u of DEFAULT_UNITS) {
    try {
      await unitRepo.create({ shopId: null, name: u.name, symbol: u.symbol, kind: u.kind, allowsDecimal: u.allowsDecimal, isShared: true });
    } catch (err) {
      if (!(err instanceof UniqueConstraintError)) throw err;
    }
  }
}

export async function listUnits(ctx: TenantContext) {
  // Keyed off store state (not an in-memory flag) so it self-heals a fresh database.
  const platform = await unitRepo.listPlatform();
  if (!platform.length) await ensureDefaultUnits();
  const units = await unitRepo.listForShop(ctx.shopId);
  return units.sort((a, b) => Number(b.isShared) - Number(a.isShared) || a.name.localeCompare(b.name));
}

export async function createUnit(
  ctx: TenantContext,
  input: { name: string; symbol: string; kind?: UnitKind; allowsDecimal?: boolean },
) {
  try {
    return await unitRepo.create({
      shopId: ctx.shopId,
      name: input.name,
      symbol: input.symbol,
      kind: input.kind ?? UnitKind.CUSTOM,
      allowsDecimal: input.allowsDecimal ?? true,
      isShared: false,
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw ApiError.conflict('A unit with this symbol already exists', 'UNIT_EXISTS');
    }
    throw err;
  }
}

/** Validate a unit is usable by this shop (shared or its own). Used by products. */
export async function assertUsableUnit(ctx: TenantContext, unitId: string): Promise<void> {
  const unit = await unitRepo.findUsable(ctx.shopId, unitId);
  if (!unit) throw ApiError.badRequest('Invalid unit', 'INVALID_UNIT');
}
