import { z } from 'zod';
import { objectId, imageUrl } from '../../utils/validators.js';
import { CategoryStatus } from '../../repositories/dynamo/categoryRepository.js';

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000).optional(),
  image: imageUrl.nullable().optional(),
  icon: z.string().max(80).nullable().optional(),
  parentId: objectId.nullable().optional(),
  sortOrder: z.number().int().optional(),
  seoTitle: z.string().max(120).optional(),
  seoDescription: z.string().max(300).optional(),
  status: z.nativeEnum(CategoryStatus).optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = createCategorySchema.partial();
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const listCategoriesQuerySchema = z.object({
  status: z.nativeEnum(CategoryStatus).optional(),
  parentId: objectId.optional(),
});
