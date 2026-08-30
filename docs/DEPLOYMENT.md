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

## Topology

Backend and frontend are **separate repos and separate compose stacks**, joined
by the shared external Docker network `ghanipur-net`:

```
internet ──▶ :3000 frontend (Next)
                     │  rewrites /api/v1 + /uploads
                     ▼  (over ghanipur-net)
                  backend:5000 ──▶ mongo:27017
                  (127.0.0.1 only)   (not published)
```

Only port 3000 is ever exposed publicly. That keeps the refresh cookie
first-party (browser only ever talks to one origin, so no CORS and no
`SameSite=None` needed) and keeps Mongo — which runs **without authentication** —
off every public interface. Do not add a `27017:27017` port mapping: on EC2 with
an open security group that is an unauthenticated public database.

## Self-hosted (Docker Compose)
```bash
docker network create ghanipur-net     # once per machine, before either stack
```

Backend stack:
```bash
cp .env.production.example .env        # set APP_URL/API_URL/CORS_ORIGINS + secrets
docker compose up -d --build
```
- Mongo starts as single-node replica set `rs0` (healthcheck initiates it).
- Backend waits for Mongo health, then serves on :5000 (loopback + `ghanipur-net`).
- Frontend is deployed from its own repo — see its README.
- Seed dev data: `docker compose exec backend node dist/scripts/seed.js`.

### DynamoDB
`server.ts` pings DynamoDB at boot, but no module reads it yet — every repository
still goes through Mongoose. `DYNAMO_REQUIRED=false` (the default) makes an
unreachable table a warning instead of a fatal boot error, so the stack runs on
Mongo alone. Set it to `true` once the port is complete and the tables are
provisioned (`./provision-dynamodb.sh`, run from AWS CloudShell).

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
