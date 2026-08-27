import { z } from 'zod';
import { objectId } from '../../utils/validators.js';
import { ProductStatus } from '../../models/product.model.js';
import { InventoryTxnType } from '../../constants/inventory.js';

const money = z.number().min(0).max(100_000_000); // rupees

export const createProductSchema = z.object({
  name: z.string().trim().min(1).max(120),
  categoryId: objectId,
  unitId: objectId,
  sku: z.string().trim().min(1).max(40).optional(),
  description: z.string().max(2000).optional(),
  images: z.array(z.string().url()).max(8).optional(),
  unitValue: z.number().positive().optional(),
  sellingPrice: money,
  purchaseCost: money.optional(),
  taxRate: z.number().min(0).max(100).optional(),
  taxInclusive: z.boolean().optional(),
  minStock: z.number().min(0).optional(),
  trackInventory: z.boolean().optional(),
  isAvailable: z.boolean().optional(),
  deliveryAvailable: z.boolean().optional(),
  status: z.nativeEnum(ProductStatus).optional(),
  openingStock: z.number().min(0).optional(),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema
  .omit({ openingStock: true })
  .partial();
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const listProductsQuerySchema = z.object({
  categoryId: objectId.optional(),
  status: z.nativeEnum(ProductStatus).optional(),
  isAvailable: z.enum(['true', 'false']).optional(),
  lowStock: z.enum(['true', 'false']).optional(),
});

// Manual inventory movement from the product screen (§9).
export const inventoryMovementSchema = z.object({
  type: z.enum([InventoryTxnType.STOCK_IN, InventoryTxnType.WASTAGE, InventoryTxnType.ADJUSTMENT, InventoryTxnType.RETURN]),
  quantity: z.number().refine((n) => n !== 0, 'Quantity cannot be zero'),
  note: z.string().max(300).optional(),
});
export type InventoryMovementInput = z.infer<typeof inventoryMovementSchema>;
