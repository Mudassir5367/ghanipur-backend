import { z } from 'zod';
import { ShopStatus } from '../../repositories/dynamo/shopRepository.js';
import { imageUrl } from '../../utils/validators.js';

const geoSchema = z.object({ lat: z.number(), lng: z.number() }).partial();

const addressSchema = z
  .object({
    line: z.string().max(200),
    city: z.string().max(80),
    area: z.string().max(80),
    geo: geoSchema,
  })
  .partial();

const deliverySettingsSchema = z
  .object({
    enabled: z.boolean(),
    feeMinor: z.number().int().min(0),
    minOrderMinor: z.number().int().min(0),
    radiusKm: z.number().min(0),
  })
  .partial();

/** Fields a shop admin may edit on their own shop (no slug/status/owner). */
export const updateShopSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    logo: imageUrl.nullable(),
    banner: imageUrl.nullable(),
    description: z.string().max(2000),
    phone: z.string().trim().max(20),
    whatsapp: z.string().trim().max(20),
    email: z.string().trim().toLowerCase().email(),
    address: addressSchema,
    businessHours: z.record(z.unknown()),
    socialLinks: z.record(z.string()),
    timezone: z.string().max(60),
    currency: z.string().length(3),
    deliverySettings: deliverySettingsSchema,
  })
  .partial();
export type UpdateShopInput = z.infer<typeof updateShopSchema>;

/** Super admin creating a shop together with its owner account. */
export const createShopSchema = z.object({
  shopName: z.string().trim().min(2).max(80),
  ownerName: z.string().trim().min(2).max(80),
  ownerEmail: z.string().trim().toLowerCase().email(),
  ownerPassword: z.string().min(8).max(128),
  phone: z.string().trim().max(20).optional(),
  status: z.nativeEnum(ShopStatus).optional(),
});
export type CreateShopInput = z.infer<typeof createShopSchema>;

export const createMyShopSchema = z.object({
  shopName: z.string().trim().min(2).max(80),
  phone: z.string().trim().max(20).optional(),
});

export const updateStatusSchema = z.object({
  status: z.nativeEnum(ShopStatus),
});

export const listShopsQuerySchema = z.object({
  status: z.nativeEnum(ShopStatus).optional(),
});

export const updateSettingsSchema = z
  .object({
    paymentMethods: z.array(z.string().trim().min(1).max(30)).min(1),
    customerTypes: z.array(z.string().trim().min(1).max(30)).min(1),
    locale: z.string().max(10),
    theme: z.record(z.unknown()),
  })
  .partial();
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
