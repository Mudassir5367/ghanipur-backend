import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

export const UnitKind = { VOLUME: 'VOLUME', WEIGHT: 'WEIGHT', COUNT: 'COUNT', CUSTOM: 'CUSTOM' } as const;
export type UnitKind = (typeof UnitKind)[keyof typeof UnitKind];

/** Units can be platform-shared (shopId=null) or shop-specific (§7). */
const unitSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', default: null, index: true },
    name: { type: String, required: true, trim: true },
    symbol: { type: String, required: true, trim: true },
    kind: { type: String, enum: Object.values(UnitKind), default: UnitKind.CUSTOM },
    allowsDecimal: { type: Boolean, default: true },
    isShared: { type: Boolean, default: false },
  },
  { timestamps: true },
);

unitSchema.index({ shopId: 1, symbol: 1 }, { unique: true });

export type UnitDoc = InferSchemaType<typeof unitSchema> & { _id: Types.ObjectId };

export const Unit = model('Unit', unitSchema);

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
