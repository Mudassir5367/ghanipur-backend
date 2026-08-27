import { z } from 'zod';
import { objectId } from '../../utils/validators.js';

export const createConversionSchema = z.object({
  sourceProductId: objectId,
  targetProductId: objectId,
  quantity: z.number().positive('Quantity must be greater than 0'),
}).refine((v) => v.sourceProductId !== v.targetProductId, {
  message: 'Source and target products must be different',
  path: ['targetProductId'],
});
export type CreateConversionInput = z.infer<typeof createConversionSchema>;
