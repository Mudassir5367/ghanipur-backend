# GHANIPUR — Implementation Roadmap

Modular monolith, built phase by phase (§76). Each phase ends with: types check,
lint, tests for that phase, manual API verification, then continue.

## Frontend route plan (§ frontend)
```
/                         public homepage
/shops                    shop discovery
/shop/[slug]              shop storefront
/shop/[slug]/[product]    product detail
/login  /register
/dashboard                shop admin (KPIs)
/dashboard/sales          + /new (quick sale)
/dashboard/products       + /new /[id]
/dashboard/categories
/dashboard/customers       + /[id] (ledger)
/dashboard/inventory       (daily milk mgmt)
/dashboard/payments        + /new (quick payment)
/dashboard/deliveries
/dashboard/expenses
/dashboard/reports
/dashboard/settings
/admin                    super-admin overview
/admin/shops  /admin/users  /admin/audit  /admin/settings
```

## Phases
- [x] **Phase 0** — Planning docs (this folder), toolchain check, repo scaffold.
- [x] **Phase 1** — Foundation: env config, Mongo, logger, error handling, User+Shop
      models, auth (register/login/refresh/logout/me), RBAC, tenant middleware,
      health endpoints, Docker Compose, seed skeleton. ✅ typecheck + 7 auth tests green.
- [x] **Phase 2** — Shops: own-shop profile + settings (dynamic payment methods /
      customer types), staff management, super-admin shop lifecycle (approve/suspend/
      activate/create), public shop listing, central tenant-scoped repository.
      ✅ 26 backend tests green incl. §61 tenant-isolation suite; settings + admin-shops UI.
- [x] **Phase 3** — Dynamic categories (nested, delete guards), shared+custom units,
      products (slug/sku, prices in paisa, opening stock), and the append-only
      InventoryTransaction ledger with concurrency-safe atomic stock (§36).
      ✅ 35 backend tests incl. concurrency + catalog isolation; categories/products/
      inventory UI with DataTable, stock modal + ledger.
- [x] **Phase 4+5** — Sales (cash + credit, atomic §48), customers, append-only
      customer ledger, payments, reversals, outstanding balances. LedgerService is
      the single source of truth for balances (§78). ✅ 45 backend tests incl. atomic
      rollback, sale/payment reversal, ledger concurrency, and full cross-shop
      isolation; Quick Sale + Quick Payment UI, customers list + ledger detail.
- [x] **Phase 6** — Deliveries: full financial delivery system — per-line price/SKU/
      category/image snapshots (§14), subtotal/discount/charge/grand-total, cash &
      credit, partial payments with immutable payment history (§7), payment status
      (Paid/Partially Paid/Due), status flow PENDING→CONFIRMED→OUT_FOR_DELIVERY→
      DELIVERED/CANCELLED with **inventory deducted on confirm** (atomic, guarded, no
      double-deduct) and **restored on cancel** (§5/§6/§15), per-customer delivery
      outstanding (§10). ✅ 13 delivery tests (all 7 spec scenarios) — 79 backend total;
      deliveries board + create form (live pricing) + detail view (payments, confirm/cancel).
- [x] **Phase 7** — Reports & dashboards: timezone-aware (§50) daily/monthly/dashboard
      aggregations, daily-milk management (opening/in/sold/wastage/closing from the
      ledger — §10), super-admin platform overview (§29). ReportService is the single
      source of truth (§78). ✅ 54 backend tests incl. verified report math; admin
      dashboard KPIs, Reports page (daily/monthly/milk), platform overview UI.
- [x] **Phase 8** — Public storefront: unauthenticated endpoints (ACTIVE shops /
      available products only, purchase cost never leaked), SSR shop + product pages
      with dynamic metadata, canonical URLs, Open Graph, JSON-LD (Store/Product),
      dynamic sitemap + robots (§27, §43). ✅ 58 backend tests incl. cost-leak guard.
- [x] **Phase 9** — Hardening: gzip compression, CDN cache headers on public catalog
      (§35), indexes on every model, rate limits (global + auth), mongo-sanitize,
      helmet, error sanitization. Audit in `docs/AUDIT.md`.
- [x] **Phase 10** — Production Docker (backend + Next standalone frontend + replica-set
      Mongo compose), health/ready probes, `docs/DEPLOYMENT.md`, completion audit (§82).

## Definition of Done (§86)
A feature counts only when: model + validation + authz + service + controller + route
+ error/loading/empty/success states in UI + tests where appropriate, working
end-to-end. No TODO placeholders for core functionality.
