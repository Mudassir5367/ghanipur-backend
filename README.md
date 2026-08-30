# GHANIPUR

Multi-shop dairy management platform + future e-commerce marketplace. Manage milk,
dahi, ghee and any products across many independent shops, with credit (udhaar)
ledgers, inventory, deliveries and reports — under a super-admin managed platform.

> Modular monolith. Node/Express/TypeScript API + Next.js/TypeScript/Tailwind web,
> MongoDB, multi-tenant with strict per-shop isolation. Built phase by phase — see
> [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Stack
- **Backend:** Node 20, Express, TypeScript, Mongoose (MongoDB), Zod, argon2, JWT, pino.
- **Frontend:** Next.js 14 (App Router), TypeScript, Tailwind, TanStack Query, Zustand.
- **Infra:** Docker + Docker Compose (MongoDB single-node replica set for transactions).

## Docs
- [Architecture](docs/ARCHITECTURE.md) · [Database](docs/DATABASE.md) ·
  [API](docs/API.md) · [Permissions](docs/PERMISSIONS.md) · [Roadmap](docs/ROADMAP.md)

## Quick start (local, without Docker)

Requires a running MongoDB **replica set** for multi-doc transactions. Easiest is
Docker Compose (below); or point `MONGO_URI` at MongoDB Atlas.

```bash
# Backend
cd backend
cp .env.example .env          # adjust secrets
npm install
npm run seed                  # creates super admin + demo shop
npm run dev                   # http://localhost:5000

# Frontend (new terminal)
cd frontend
cp .env.example .env.local
npm install
npm run dev                   # http://localhost:3000
```

Seeded logins (dev only):
- Super Admin — `superadmin@ghanipur.test` / `password123`
- Shop Admin — `admin@ghanipur.test` / `password123`

### Roles & sign-up (§1)
- **Public signup** (`/register`, `POST /auth/register`) creates a **normal USER** only.
- **Shop admins** are provisioned by a super admin via `POST /admin/register`, then log
  in and create their shop (`POST /shops/mine`) — which seeds starter categories.
- **Super admins** are bootstrapped via `POST /super-admin/register` with the
  `x-setup-key` header (`SUPER_ADMIN_SETUP_KEY`), or created by an existing super admin.
  There is no public admin/super-admin signup.

## Quick start (Docker Compose)

The backend and frontend are separate repos deployed to **separate machines**.
This stack runs **Mongo + the API**; the frontend has its own
`docker-compose.yml` in the `ghanipur-frontend` repo and reaches this API by
address, proxying `/api/v1` and `/uploads` to it.

```bash
cp .env.production.example .env        # fill in the secrets
docker compose up -d --build
```

Mongo runs as a single-node replica set (`rs0`) so transactions work. The backend
waits for Mongo's healthcheck, which also initiates the replica set.

Port 5000 is published because the other machine has to reach it, so **the
security group is the access control** — restrict inbound 5000 to the frontend
instance. **Mongo runs without authentication** and is never published; it is
reachable only from the backend container. Full procedure in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Scripts
| Location | Command | Purpose |
|---|---|---|
| backend | `npm run dev` | Dev server (tsx watch) |
| backend | `npm run typecheck` | TS type check |
| backend | `npm test` | Vitest (in-memory Mongo replica set) |
| backend | `npm run seed` | Seed dev data |
| backend | `npm run build && npm start` | Production build + run |
| frontend | `npm run dev` | Next dev server |
| frontend | `npm run typecheck` | TS type check |
| frontend | `npm run build` | Production build |

## Status — all 10 phases complete
Foundation & auth (RBAC, JWT + refresh) · multi-tenant shops (approval lifecycle,
settings, staff) · dynamic categories/units/products · concurrency-safe inventory
ledger · atomic cash/credit sales · customer ledger + payments + reversals ·
deliveries · timezone-aware reports & dashboards + daily-milk management · public
storefront + SEO · hardening + production Docker. **70 backend tests across 14 suites,
all green** (incl. tenant isolation §61, inventory/ledger concurrency §36/§37, atomic
sale rollback §48). See [`docs/ROADMAP.md`](docs/ROADMAP.md) and
[`docs/AUDIT.md`](docs/AUDIT.md). Frontend builds clean (`next build`, standalone).

Product image upload is implemented on local disk storage (S3-ready — URLs stored in
DB). Deferred by design (architecture ready — §77): online cart/checkout/payments,
subscriptions, WhatsApp/SMS, profit/cost-per-litre analytics, CSV/PDF export, moving
uploads to S3/cloud object storage, OpenAPI spec.

> **Testing note:** the backend test suite uses an in-memory MongoDB replica set,
> which on Windows needs the Microsoft VC++ runtime installed. Alternatively set
> `MONGO_TEST_URI` to an external replica set (e.g. the Docker Compose Mongo).
