# GHANIPUR — Deployment

## Architecture recap
- **backend** — stateless Node/Express API (scale horizontally behind a load balancer).
- **frontend** — Next.js (standalone) SSR app.
- **mongo** — MongoDB **replica set** (required for multi-document transactions — §36/§48).

Nothing is hardcoded: all URLs/secrets come from env (§42).

## Environment variables

### Backend (`backend/.env`)
| Var | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `PORT` | no | default 5000 |
| `MONGO_URI` | **yes** | must point at a replica set / Atlas |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | **yes** | ≥16 chars; `openssl rand -hex 32` |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | no | `15m` / `7d` |
| `CORS_ORIGINS` | yes | comma-separated allowlist (your frontend origin) |
| `APP_URL` / `API_URL` | yes | public URLs |
| `COOKIE_DOMAIN` | prod | e.g. `.ghanipur.com` so the refresh cookie spans subdomains |
| `RATE_LIMIT_*`, `LOG_LEVEL` | no | sensible defaults |

Boot **fails fast** if required vars are missing or malformed.

### Frontend (build-time)
`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_URL` — baked into the client bundle at build.

## Local / self-hosted (Docker Compose)
```bash
export JWT_ACCESS_SECRET=$(openssl rand -hex 32)
export JWT_REFRESH_SECRET=$(openssl rand -hex 32)
docker compose up --build
```
- Mongo starts as single-node replica set `rs0` (healthcheck initiates it).
- Backend waits for Mongo health, then serves on :5000.
- Frontend serves on :3000.
- Seed dev data: `docker compose exec backend node dist/scripts/... ` or run `npm run seed` against the Mongo URI.

## Production notes
- **Cookies**: in production the refresh cookie is `Secure` + `SameSite=None`; serve over HTTPS and set `COOKIE_DOMAIN`. Put the API behind TLS (reverse proxy / load balancer).
- **Mongo**: use Atlas or a managed replica set. Back up regularly. Financial data is immutable by design (corrections are reversals — §79).
- **Scaling**: the API is stateless (JWT + cookie), so run N replicas behind a load balancer. Mongo connection pooling is configured (`maxPoolSize`).
- **Indexes**: declared on every model (shopId, slug, sku, phone, dates, refs — §23). Mongoose builds them on connect in non-prod; for large prod datasets create them ahead of time / during a maintenance window.
- **Caching/CDN**: public storefront responses send `Cache-Control: public, max-age=60, stale-while-revalidate=300`; front them with a CDN. Financial/inventory endpoints are never cached (§35).
- **Images**: wire `NEXT_PUBLIC` + object storage (S3) for uploads when enabled (§40) — the product/shop image fields already store URLs.
- **Health**: `GET /health` (liveness), `GET /health/ready` (DB). Point your orchestrator's probes here.
- **Logs**: structured JSON (pino) in production; ship to your log aggregator. Secrets are redacted.

## Custom domains (future)
Shop routing goes through a single `resolveShop()` seam (path-based today:
`/shop/<slug>`). Subdomain (`<slug>.ghanipur.com`) and custom domains slot in there
without touching call sites (§69).
