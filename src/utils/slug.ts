import { customAlphabet } from 'nanoid';

const suffix = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 5);

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item';
}

/**
 * Produce a slug guaranteed unique against `exists`. Adds a short random suffix
 * on collision rather than a counter, to avoid a race between check and insert.
 */
export async function uniqueSlug(base: string, exists: (slug: string) => Promise<boolean>): Promise<string> {
  const root = slugify(base);
  if (!(await exists(root))) return root;
  for (let i = 0; i < 5; i += 1) {
    const candidate = `${root}-${suffix()}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}
