/**
 * Development seed (§62). Creates a Super Admin, a demo Shop Admin, and a demo Shop
 * with categories, products, customers, a sale and a payment.
 * NEVER run automatically in production — this script refuses when NODE_ENV=production.
 */
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import * as userRepo from '../repositories/dynamo/userRepository.js';
import * as shopRepo from '../repositories/dynamo/shopRepository.js';
import * as settingsRepo from '../repositories/dynamo/shopSettingsRepository.js';
import * as categoryRepo from '../repositories/dynamo/categoryRepository.js';
import * as productRepo from '../repositories/dynamo/productRepository.js';
import * as unitRepo from '../repositories/dynamo/unitRepository.js';
import { expenses } from '../repositories/dynamo/miscRepositories.js';
import { ShopStatus } from '../repositories/dynamo/shopRepository.js';
import { Role } from '../constants/roles.js';
import { hashPassword } from '../services/token.service.js';
import { slugify } from '../utils/slug.js';
import { toMinor } from '../utils/money.js';
import { ensureDefaultUnits } from '../modules/unit/unit.service.js';
import { recordMovement } from '../services/inventory.service.js';
import { InventoryTxnType, RefType } from '../constants/inventory.js';
import { provisionShop } from '../modules/shop/shop.service.js';
import { createCustomer } from '../modules/customer/customer.service.js';
import { createSale } from '../modules/sale/sale.service.js';
import { recordPayment } from '../modules/payment/payment.service.js';

async function seed(): Promise<void> {
  // Never auto-seed production data. In a prod-built image (e.g. Docker), an explicit
  // ALLOW_SEED=true is required to seed a fresh/demo database on purpose.
  if (env.isProd && process.env.ALLOW_SEED !== 'true') {
    logger.error('Refusing to seed in production (set ALLOW_SEED=true to override)');
    process.exit(1);
  }

  const superEmail = 'superadmin@ghanipur.test';
  const adminEmail = 'admin@ghanipur.test';
  const password = 'password123';

  // Clean slate for demo entities. hardDelete also releases the slug/sku/owner/email
  // guards, so re-seeding never collides with a stale reservation.
  const existingShop = await shopRepo.findBySlug('demo-dairy');
  if (existingShop) {
    for (const p of await productRepo.listByShop(existingShop.id)) {
      await productRepo.hardDelete(existingShop.id, p.id, p.slug, p.sku);
    }
    for (const c of await categoryRepo.listByShop(existingShop.id)) {
      await categoryRepo.hardDelete(existingShop.id, c.id, c.slug);
    }
    await settingsRepo.remove(existingShop.id);
    await shopRepo.hardDelete(existingShop);
  }
  for (const email of [superEmail, adminEmail]) {
    const existing = await userRepo.findByEmail(email);
    if (existing) await userRepo.hardDelete(existing.id, existing.email);
  }

  const hash = await hashPassword(password);
  await ensureDefaultUnits();
  const litre = await unitRepo.findBySymbol(null, 'L');
  const kg = await unitRepo.findBySymbol(null, 'kg');

  await userRepo.create({ name: 'Super Admin', email: superEmail, passwordHash: hash, role: Role.SUPER_ADMIN });

  const admin = await userRepo.create({
    name: 'Demo Owner',
    email: adminEmail,
    passwordHash: hash,
    role: Role.SHOP_ADMIN,
    phone: '03001112222',
  });
  // Provision the shop with default settings + starter categories (§3), then activate it.
  const shop = await provisionShop(undefined, { _id: admin.id }, 'Demo Dairy', {
    phone: '03001112222',
    status: ShopStatus.ACTIVE,
  });
  await userRepo.update(admin.id, { shopId: shop.id });

  // Products reference the seeded default categories (§62).
  const ctx = { shopId: shop.id, impersonated: false };
  const cats = await categoryRepo.listByShop(shop.id);
  const catByName = (name: string) => cats.find((c) => c.name === name)!.id;

  const demoProducts = [
    { name: 'Buffalo Milk', cat: catByName('Milk'), unit: litre!.id, sell: 250, cost: 210, open: 120, min: 20 },
    { name: 'Cow Milk', cat: catByName('Milk'), unit: litre!.id, sell: 220, cost: 185, open: 80, min: 15 },
    { name: 'Fresh Dahi', cat: catByName('Yogurt'), unit: kg!.id, sell: 300, cost: 240, open: 25, min: 5 },
    { name: 'Pure Desi Ghee 1L', cat: catByName('Desi Ghee'), unit: litre!.id, sell: 2600, cost: 2200, open: 15, min: 3 },
  ];
  let buffaloMilkId = '';
  for (const p of demoProducts) {
    const product = await productRepo.create({
      shopId: shop.id,
      categoryId: p.cat,
      unitId: p.unit,
      name: p.name,
      slug: slugify(p.name),
      sku: slugify(p.name).toUpperCase().replace(/-/g, ''),
      sellingPriceMinor: toMinor(p.sell),
      purchaseCostMinor: toMinor(p.cost),
      minStock: p.min,
    });
    if (p.name === 'Buffalo Milk') buffaloMilkId = product.id;
    await recordMovement(ctx, {
      productId: product.id,
      type: InventoryTxnType.STOCK_IN,
      quantity: p.open,
      refType: RefType.PRODUCT,
      refId: product.id,
      performedBy: admin.id,
      note: 'Opening stock',
    });
  }

  // Customers + a credit sale + a partial payment (exercises the real services — §62)
  const aliHotel = await createCustomer(ctx, { name: 'Ali Hotel', phone: '03009998888', type: 'HOTEL' }, admin.id);
  await createCustomer(ctx, { name: 'Bilal Household', phone: '03007776666', type: 'HOUSEHOLD' }, admin.id);

  await createSale(ctx, { type: 'CASH', items: [{ productId: buffaloMilkId, quantity: 15 }] }, admin.id);
  await createSale(ctx, { type: 'CREDIT', customerId: aliHotel.id, items: [{ productId: buffaloMilkId, quantity: 30 }] }, admin.id);
  await recordPayment(ctx, { customerId: aliHotel.id, amount: 3000, method: 'CASH' }, admin.id);

  await expenses.create({ shopId: shop.id, category: 'Rent', amountMinor: toMinor(50000), createdBy: admin.id });
  await expenses.create({ shopId: shop.id, category: 'Electricity', amountMinor: toMinor(35000), createdBy: admin.id });

  logger.info('✅ Seed complete');
  logger.info(`   Super Admin:  ${superEmail} / ${password}`);
  logger.info(`   Shop Admin:   ${adminEmail} / ${password}  (shop: ${shop.slug})`);

  process.exit(0);
}

seed().catch((err) => {
  logger.fatal({ err }, 'Seed failed');
  process.exit(1);
});
