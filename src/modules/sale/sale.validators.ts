import { z } from 'zod';
import { objectId } from '../../utils/validators.js';
import { SaleType } from '../../constants/sales.js';

export const saleItemSchema = z
  .object({
    productId: objectId,
    // Either sell a quantity, or sell a rupee `amount` and let the system derive the
    // quantity (amount ÷ unit price). Exactly one of the two is used per line.
    quantity: z.number().positive().optional(),
    amount: z.number().positive().optional(), // rupees worth of the product to sell
    unitPrice: z.number().min(0).optional(), // rupees; overrides product price if given
  })
  .refine((v) => v.quantity !== undefined || v.amount !== undefined, {
    message: 'Provide either a quantity or an amount',
    path: ['quantity'],
  });

// Customer is optional for both cash and credit. A credit sale without a customer
// is an unassigned receivable — its due is tracked on the sale itself and still
// counts toward the shop's outstanding total (see report.service outstandingTotal).
export const createSaleSchema = z.object({
  type: z.nativeEnum(SaleType),
  customerId: objectId.optional(),
  customerPhone: z.string().trim().max(20).optional(), // optional phone for a walk-in
  items: z.array(saleItemSchema).min(1, 'At least one item is required'),
  paymentMethod: z.string().trim().max(30).optional(),
  note: z.string().max(500).optional(),
});
export type CreateSaleInput = z.infer<typeof createSaleSchema>;

export const listSalesQuerySchema = z.object({
  type: z.nativeEnum(SaleType).optional(),
  status: z.enum(['COMPLETED', 'CANCELLED']).optional(),
  customerId: objectId.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
