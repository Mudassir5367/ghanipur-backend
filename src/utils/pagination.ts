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

/**
 * Applies search, sort and paging to a set already read from DynamoDB, keeping
 * the `{page, limit, total, totalPages}` contract the API and frontend rely on.
 *
 * DynamoDB has no offset and no cheap COUNT, so the alternative is a cursor API
 * — a breaking change for every list screen. Reads stay inside one tenant
 * (shopId is the partition key), which is what makes this affordable.
 */
export function paginateInMemory<T>(
  rows: T[],
  { skip, limit, sort }: Pick<ParsedPagination, 'skip' | 'limit' | 'sort'>,
  searchFields?: { search?: string; fields: (row: T) => (string | null | undefined)[] },
): { data: T[]; total: number } {
  let items = rows;

  const needle = searchFields?.search?.trim().toLowerCase();
  const fieldsOf = searchFields?.fields;
  if (needle && fieldsOf) {
    items = items.filter((row) =>
      fieldsOf(row).some((v) => typeof v === 'string' && v.toLowerCase().includes(needle)),
    );
  }

  const [field, direction] = Object.entries(sort)[0] ?? [];
  if (field) {
    const dir = direction === -1 ? -1 : 1;
    items = [...items].sort((a, b) => {
      const av = (a as Record<string, unknown>)[field];
      const bv = (b as Record<string, unknown>)[field];
      if (av === bv) return 0;
      if (av === undefined || av === null) return 1; // missing values sort last either way
      if (bv === undefined || bv === null) return -1;
      return (av < bv ? -1 : 1) * dir;
    });
  }

  return { data: items.slice(skip, skip + limit), total: items.length };
}

/** Parse common list query params into pagination fields (§34). */
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
