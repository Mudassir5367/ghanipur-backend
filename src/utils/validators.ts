import { z } from 'zod';

/** Reusable Mongo ObjectId param schema. */
export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

export const idParamSchema = z.object({ id: objectId });
export const slugParamSchema = z.object({ slug: z.string().min(1).max(80) });
