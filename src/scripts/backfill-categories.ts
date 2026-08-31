/**
 * One-off migration: seed the default starter categories (§3) into any existing
 * shop that has none. New shops already get them via provisionShop; this backfills
 * legacy shops created before that behaviour existed. Idempotent — skips shops that
 * already have categories.
 *
 * Run:  node dist/scripts/backfill-categories.js   (inside the backend container)
 */
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../config/logger.js';
import * as shopRepo from '../repositories/dynamo/shopRepository.js';
import { Category } from '../models/category.model.js';
import { DEFAULT_CATEGORIES } from '../constants/categories.js';
import { slugify } from '../utils/slug.js';

async function run(): Promise<void> {
  await connectDatabase();
  const shops = await shopRepo.listAllActive();
  let fixed = 0;
  for (const shop of shops) {
    const count = await Category.countDocuments({ shopId: shop.id, isDeleted: false });
    if (count > 0) continue;
    await Category.create(
      DEFAULT_CATEGORIES.map((name, i) => ({ shopId: shop.id, name, slug: slugify(name), sortOrder: i })),
    );
    fixed += 1;
    logger.info(`Seeded ${DEFAULT_CATEGORIES.length} categories into ${shop.slug}`);
  }
  logger.info(`✅ Backfill complete — ${fixed} shop(s) updated, ${shops.length - fixed} already had categories`);
  await disconnectDatabase();
  process.exit(0);
}

run().catch((err) => {
  logger.fatal({ err }, 'Backfill failed');
  process.exit(1);
});
