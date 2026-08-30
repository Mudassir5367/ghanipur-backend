import { z } from 'zod';
import { objectId } from '../../utils/validators.js';
import { DeliveryStatus, PaymentType } from '../../models/delivery.model.js';

const money = z.number().min(0).max(100_000_000); // rupees

export const createDeliverySchema = z
  .object({
    customerId: objectId.optional(),
    lines: z
      // Per line: unitPrice = selling price per unit, costPrice = cost price per unit.
      .array(z.object({ productId: objectId, quantity: z.number().positive(), unitPrice: money.optional(), costPrice: money.optional() }))
      .min(1, 'At least one item is required'),
    discount: money.optional(),
    deliveryCharge: money.optional(),
    paymentType: z.nativeEnum(PaymentType).default(PaymentType.CREDIT),
    paidAmount: money.optional(), // initial payment (ignored for CASH — auto full)
    deliverNow: z.boolean().optional(), // roster one-click: save straight as DELIVERED
    assignedToName: z.string().trim().max(80).optional(),
    address: z.string().max(300).optional(),
    note: z.string().max(500).optional(),
    scheduledFor: z.string().datetime().optional(),
  })
  // A credit delivery leaves a balance owed, so it MUST name the customer who owes
  // it — otherwise it becomes an untrackable receivable that no page can reconcile.
  // Cash deliveries are paid in full, so a walk-in needs no customer.
  .refine((v) => v.paymentType !== PaymentType.CREDIT || !!v.customerId, {
    message: 'A customer is required for credit deliveries',
    path: ['customerId'],
  });
export type CreateDeliveryInput = z.infer<typeof createDeliverySchema>;

export const updateStatusSchema = z.object({
  status: z.nativeEnum(DeliveryStatus),
});

export const addPaymentSchema = z.object({
  amount: z.number().positive(),
  method: z.string().trim().max(30).optional(),
  note: z.string().max(300).optional(),
});
export type AddPaymentInput = z.infer<typeof addPaymentSchema>;

export const listDeliveriesQuerySchema = z.object({
  status: z.nativeEnum(DeliveryStatus).optional(),
  paymentStatus: z.enum(['PAID', 'PARTIALLY_PAID', 'DUE']).optional(),
  customerId: objectId.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
