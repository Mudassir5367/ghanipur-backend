# syntax=docker/dockerfile:1

# ---- Build stage ----
# Debian (glibc) rather than Alpine (musl): `argon2` is a native module and its
# prebuilt binaries target glibc, so Alpine forces a source compile. The build
# toolchain is here anyway as a fallback if a prebuild is ever missing; it never
# reaches the runtime image.
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# Prune dev deps after compiling so the runtime stage can copy node_modules
# straight across — no second install, no toolchain needed downstream.
RUN npm run build && npm prune --omit=dev

# ---- Runtime stage ----
FROM node:20-bookworm-slim AS runtime
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
