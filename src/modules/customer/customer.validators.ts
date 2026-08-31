import { z } from 'zod';
import { CustomerStatus } from '../../repositories/dynamo/customerRepository.js';

export const createCustomerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(20).optional(),
  altPhone: z.string().trim().max(20).optional(),
  address: z.string().max(300).optional(),
  type: z.string().trim().max(30).optional(),
  notes: z.string().max(1000).optional(),
  creditLimit: z.number().min(0).optional(), // rupees
  openingBalance: z.number().optional(), // rupees; positive = customer owes shop
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(20),
  altPhone: z.string().trim().max(20),
  address: z.string().max(300),
  type: z.string().trim().max(30),
  notes: z.string().max(1000),
  creditLimit: z.number().min(0),
  status: z.nativeEnum(CustomerStatus),
}).partial();
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const listCustomersQuerySchema = z.object({
  status: z.nativeEnum(CustomerStatus).optional(),
  type: z.string().optional(),
  hasDue: z.enum(['true', 'false']).optional(),
});
