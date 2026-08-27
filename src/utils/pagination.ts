import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().optional(),
  search: z.string().trim().optional(),
});

export type PaginationQuery = z.infer<typeof paginationSchema>;

export interface ParsedPagination {
  page: number;
  limit: number;
  skip: number;
  sort: Record<string, 1 | -1>;
  search?: string;
}

/** Parse common list query params into Mongo-ready pagination (§34). */
export function parsePagination(query: unknown, defaultSort = '-createdAt'): ParsedPagination {
  const { page, limit, sort, search } = paginationSchema.parse(query);
  const sortSpec = (sort || defaultSort)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .reduce<Record<string, 1 | -1>>((acc, field) => {
      if (field.startsWith('-')) acc[field.slice(1)] = -1;
      else acc[field] = 1;
      return acc;
    }, {});
  return { page, limit, skip: (page - 1) * limit, sort: sortSpec, search };
}
