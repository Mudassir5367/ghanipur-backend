# GHANIPUR — API Design (§33)

Base: `/api/v1`. JSON only. Versioned. Consistent envelopes.

## Response envelopes
Success:
```json
{ "success": true, "data": { }, "meta": { "page": 1, "limit": 20, "total": 0 } }
```
Error (§39):
```json
{ "success": false, "message": "Product not found", "code": "PRODUCT_NOT_FOUND", "errors": [] }
```
No stack traces in production; details logged internally with a request id.

## Pagination / filtering (§34)
Query params on all list endpoints: `page, limit, sort, search, <filters>`.
`meta` returns `page, limit, total, totalPages`. Cursor pagination for high-volume
ledgers/audit where it helps.

## Endpoints (built phase by phase)
```
# Auth
POST   /auth/register              # PUBLIC — normal USER signup only (no shop)
POST   /auth/login                 # all roles
POST   /auth/logout
POST   /auth/refresh
GET    /auth/me
POST   /auth/forgot-password       # architecture stub
POST   /auth/reset-password

# Admin provisioning (NOT public signup — §1)
POST   /admin/register             # SUPER_ADMIN only -> creates SHOP_ADMIN (+ optional shop)
POST   /super-admin/register       # x-setup-key header (bootstrap) or existing SUPER_ADMIN

# Shop self-onboarding (§2)
POST   /shops/mine                 # logged-in SHOP_ADMIN with no shop -> creates own shop,
                                    #   seeds default categories, returns a refreshed token

# Shops (Phase 2)
GET    /shops                      # super-admin: all; public: active only (subset)
POST   /shops                      # super-admin create
GET    /shops/:slug
PATCH  /shops/:id
POST   /shops/:id/approve|suspend|activate
GET    /shops/:id/staff  POST /shops/:id/staff

# Categories / Units / Products (Phase 3)
GET|POST            /categories
GET|PATCH|DELETE    /categories/:id
GET|POST            /units
GET|POST            /products
GET                 /products/sku/suggest     # auto-generate a unique SKU (§4)
GET|PATCH|DELETE    /products/:id
GET                 /products/:id/inventory   # ledger history
POST                /products/:id/inventory   # stock-in / adjustment / wastage
POST                /uploads                  # product image upload -> { url } (§8)

# Sales (Phase 4)
POST   /sales                      # cash or credit (atomic)
GET    /sales                      # filter type/date/customer
GET    /sales/:id
POST   /sales/:id/reverse

# Customers / Ledger / Payments (Phase 5)
GET|POST            /customers
GET|PATCH|DELETE    /customers/:id
GET                 /customers/:id/ledger
POST                /payments
GET                 /payments
POST                /payments/:id/reverse

# Deliveries (Phase 6)
GET|POST   /deliveries
PATCH      /deliveries/:id/status

# Expenses
GET|POST   /expenses

# Reports (Phase 7)
GET /reports/daily?date=
GET /reports/monthly?month=
GET /reports/product/:id
GET /reports/customer/:id
GET /reports/inventory
GET /reports/dashboard             # admin KPIs
GET /reports/daily-milk?date=      # daily milk mgmt (§10)

# Super Admin
GET /admin/overview                # platform KPIs (§29)
GET /admin/audit-logs

# Public storefront (Phase 8)
GET /public/shops
GET /public/shops/:slug
GET /public/shops/:slug/products
GET /public/products/:slug

# Ops
GET /health   GET /health/ready
```

## Conventions
- Mutations require permission + tenant context; list/detail auto-scoped to shop.
- Dates are ISO; server applies shop timezone for report bucketing (§50).
- Idempotency-Key header accepted on POST /sales and /payments to guard double-submit.
