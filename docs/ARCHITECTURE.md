# GHANIPUR — Architecture

Multi-tenant dairy management + future e-commerce platform.

## 1. High-level shape

A **modular monolith** (§70). One backend process, one frontend app, clean module
boundaries so any module can later be extracted into a service.

```
ghanipur/
├── backend/      Node + Express + TypeScript + Mongoose (REST API, /api/v1)
├── frontend/     Next.js (App Router) + TypeScript + Tailwind
├── docs/         Architecture, DB, API, permissions, roadmap
└── docker-compose.yml
```

Backend is **stateless** (§70): no in-memory sessions; auth is JWT + refresh cookie,
so it scales horizontally behind a load balancer.

## 2. Multi-tenancy (§22, §61)

Every shop-owned document carries `shopId`. Isolation is enforced in the **data-access
layer**, never the frontend:

1. `authenticate` → resolves the user + role from the access token.
2. `resolveTenant` → determines the active `shopId`:
   - SHOP_ADMIN / staff: their own `shopId` (locked to their account).
   - SUPER_ADMIN: may target any shop via an explicit, audit-logged header/param.
3. Repositories receive a `TenantContext` and **always** merge `{ shopId }` into every
   query and every insert. There is no code path that reads a shop-owned collection
   without a tenant filter.

A backend integration test (§61) asserts Shop A cannot read Shop B's customers,
products, sales, payments, inventory, categories, reports, expenses, deliveries.

## 3. Shop / domain resolution (§21, §69)

Chosen now: **path-based** `https://ghanipur.com/shop/<slug>`.

- Works on `localhost` with zero DNS/TLS setup.
- SEO handled via per-page metadata + canonical URLs (§43).

A single `resolveShop(hostOrSlug)` service is the only place that maps an incoming
request to a shop. Future modes — `<slug>.ghanipur.com` and `customdomain.com` — are
added inside that one resolver, so no call site changes. **No URL is hardcoded**;
everything flows from env (`APP_URL`, `API_URL`) (§42).

## 4. Request lifecycle

```
Route → validate(zod) → authenticate → authorize(permissions) → resolveTenant
      → controller (thin) → service (business logic) → repository (tenant-scoped)
      → model → Mongo
```

- **Controllers** are thin: parse, call service, shape response (§24).
- **Services** own business logic and are the single source of truth for every
  calculation (§78): `InventoryService`, `SalesService`, `LedgerService`,
  `PaymentService`, `ReportService`, etc. No duplicate formulas across FE/BE/reports.
- **Repositories** own persistence and tenant scoping.

## 5. Consistency & financial accuracy (§36, §37, §48)

- Inventory is **derived from an append-only `InventoryTransaction` ledger**. A cached
  `currentStock` on the product is updated with atomic `$inc` inside a transaction —
  never read-modify-write.
- A credit sale runs in **one Mongo transaction**: Sale → SaleItems →
  InventoryTransaction(s) → CustomerLedger entry → balance `$inc`. Any failure rolls
  back all of it.
- Historical records are **immutable** (§79): corrections are reversals/adjustments,
  never in-place edits. Financial docs are never soft-deleted away.

## 6. Auth & RBAC (§30, §31)

- Access token (JWT, ~15 min) in memory on the client; refresh token (~7 d) in an
  httpOnly, Secure, SameSite cookie. Argon2id password hashing.
- Roles: `SUPER_ADMIN`, `SHOP_ADMIN`, `SHOP_STAFF`, `USER` (extensible).
- Granular permission strings (e.g. `SALE_CREATE`, `PAYMENT_CREATE`, `REPORT_VIEW`).
  A single reusable `authorize(...perms)` middleware checks them — no ad-hoc checks
  scattered around (§31). See `docs/PERMISSIONS.md`.

## 7. Security (§32)

helmet · CORS allowlist · express-rate-limit · body size limits ·
express-mongo-sanitize (NoSQL injection) · zod input validation · argon2 · httpOnly
cookies · centralized error sanitizer (no stack traces in prod) · audit log ·
secrets only from env, never in responses/logs.

## 8. Observability (§72)

pino structured logging with per-request request-id; `GET /health` (liveness) and
`GET /health/ready` (DB ping). No secrets in logs.

## 9. Frontend (§25, §26, §56)

Next.js App Router. TanStack Query for server state; React Context only for auth +
active-shop; no Redux. Reusable primitives (`DataTable`, `StatCard`, `ConfirmDialog`,
`CurrencyInput`, …) in `components/ui`. Mobile-first for sales/payment entry (§51, §52).

## 10. Deferred by design (architecture supports, not built now) (§77)

Cart/checkout/online payments, subscriptions, WhatsApp/SMS, cost-per-liter & profit
analytics, CSV/PDF export, background-job queue, S3 uploads. Models carry the
extension points (e.g. `Expense`, recurring fields) without the full feature.
