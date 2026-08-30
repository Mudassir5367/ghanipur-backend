# syntax=docker/dockerfile:1

# ---- Build stage ----
# Alpine is safe here: argon2 — the only native dependency — ships prebuilds for
# BOTH libcs (prebuilds/linux-x64/argon2.musl.node alongside the glibc one), and
# node-gyp-build picks the right one, so nothing compiles from source and no
# build toolchain is needed. Everything else in the tree is pure JS.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# Prune dev deps after compiling so the runtime stage can copy node_modules
# straight across — no second install, and the image stays small enough to
# build on a 6.7GB root volume.
RUN npm run build && npm prune --omit=dev

# ---- Runtime stage ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
# Created here with the right owner: the app mkdir's it at import time, which
# would fail as non-root against a root-owned /app.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
