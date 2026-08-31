import { z } from 'zod';

/** Reusable Mongo ObjectId param schema. */
export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

export const idParamSchema = z.object({ id: objectId });
export const slugParamSchema = z.object({ slug: z.string().min(1).max(80) });

/**
 * An image location: either an absolute http(s) URL (external/CDN image) or a
 * root-relative path such as `/uploads/1712-abc.jpg`.
 *
 * The relative form matters — POST /uploads deliberately returns a same-origin
 * path so images load through the frontend proxy whatever host the app is opened
 * on. A bare `z.string().url()` rejects that, which meant the API refused the
 * URL its own upload endpoint had just issued: every product image, category
 * image, shop logo and banner upload failed with 400 at the attach step.
 */
export const imageUrl = z
  .string()
  .trim()
  .refine(
    (v) => /^https?:\/\/\S+$/i.test(v) || /^\/[^\s?#]*$/.test(v),
    'Must be an absolute http(s) URL or a root-relative path like /uploads/file.jpg',
  );
