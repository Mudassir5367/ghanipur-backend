import type {
  Model,
  FilterQuery,
  UpdateQuery,
  ProjectionType,
  QueryOptions,
  ClientSession,
  HydratedDocument,
} from 'mongoose';
import type { TenantContext } from '../types/context.js';

export interface ListOptions {
  skip?: number;
  limit?: number;
  sort?: Record<string, 1 | -1>;
  projection?: ProjectionType<unknown>;
}

export interface PageResult<T> {
  data: T[];
  total: number;
}

/**
 * Wraps a Mongoose model so EVERY read and write is scoped to a shop (§22).
 * The tenant filter (`shopId`) is injected from the request's TenantContext and
 * can never be widened by client input — there is no method that touches the
 * collection without it. All shop-owned modules must use this, not the raw model.
 */
export function tenantRepository<T>(model: Model<T>) {
  const scoped = (ctx: TenantContext, filter: FilterQuery<T> = {}): FilterQuery<T> =>
    ({ ...filter, shopId: ctx.shopId }) as FilterQuery<T>;

  return {
    model,

    scoped,

    async find(ctx: TenantContext, filter: FilterQuery<T> = {}, opts: ListOptions = {}) {
      let q = model.find(scoped(ctx, filter), opts.projection);
      if (opts.sort) q = q.sort(opts.sort);
      if (opts.skip) q = q.skip(opts.skip);
      if (opts.limit) q = q.limit(opts.limit);
      return q.exec();
    },

    async paginate(ctx: TenantContext, filter: FilterQuery<T>, opts: ListOptions): Promise<PageResult<HydratedDocument<T>>> {
      const scopedFilter = scoped(ctx, filter);
      const [data, total] = await Promise.all([
        (() => {
          let q = model.find(scopedFilter, opts.projection);
          if (opts.sort) q = q.sort(opts.sort);
          if (opts.skip) q = q.skip(opts.skip);
          if (opts.limit) q = q.limit(opts.limit);
          return q.exec();
        })(),
        model.countDocuments(scopedFilter),
      ]);
      return { data, total };
    },

    async findOne(ctx: TenantContext, filter: FilterQuery<T>, projection?: ProjectionType<T>) {
      return model.findOne(scoped(ctx, filter), projection).exec();
    },

    async findById(ctx: TenantContext, id: string, projection?: ProjectionType<T>) {
      return model.findOne(scoped(ctx, { _id: id } as FilterQuery<T>), projection).exec();
    },

    // Data is a plain object; Mongoose casts string ids to ObjectId at write time.
    async create(ctx: TenantContext, data: Record<string, unknown>, session?: ClientSession) {
      const [doc] = await model.create([{ ...data, shopId: ctx.shopId }], { session });
      return doc!;
    },

    async updateById(ctx: TenantContext, id: string, update: UpdateQuery<T>, opts: QueryOptions = {}) {
      return model
        .findOneAndUpdate(scoped(ctx, { _id: id } as FilterQuery<T>), update, { new: true, ...opts })
        .exec();
    },

    async count(ctx: TenantContext, filter: FilterQuery<T> = {}) {
      return model.countDocuments(scoped(ctx, filter));
    },

    async exists(ctx: TenantContext, filter: FilterQuery<T>) {
      return !!(await model.exists(scoped(ctx, filter)));
    },
  };
}

export type TenantRepository<T> = ReturnType<typeof tenantRepository<T>>;
