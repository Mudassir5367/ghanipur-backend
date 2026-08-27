import { z } from 'zod';
import { objectId } from '../../utils/validators.js';

export const createPaymentSchema = z.object({
  customerId: objectId,
  amount: z.number().positive(), // rupees
  method: z.string().trim().max(30).optional(),
  reference: z.string().max(100).optional(),
  note: z.string().max(500).optional(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const listPaymentsQuerySchema = z.object({
  customerId: objectId.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
