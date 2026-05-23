# syntax=docker/dockerfile:1.7

# ---- Stage 1: install deps with workspaces ----
FROM node:20.18.0-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* .npmrc ./
COPY scripts ./scripts
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
# Allow installs to skip the registry-age check inside container builds
# (the host CI is expected to enforce it before producing the lockfile).
ENV AGE_CHECK_OFFLINE=1
RUN if [ -f package-lock.json ]; then npm ci --ignore-scripts; else npm install --ignore-scripts; fi

# ---- Stage 2: build web + server ----
FROM node:20.18.0-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules
COPY . .
# Frontend deployment sub-path. Defaults to '/' for root; pass --build-arg
# DOUYIN_BASE=/dy/ for sub-path reverse proxy deployments.
ARG DOUYIN_BASE=/
ENV DOUYIN_BASE=${DOUYIN_BASE}
RUN npm run build -w @douyin-tool/web && npm run build -w @douyin-tool/server

# ---- Stage 3: lean runtime ----
FROM node:20.18.0-alpine AS runtime
ENV NODE_ENV=production \
    SERVE_STATIC=1 \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app

# Install only production deps for the server workspace
COPY package.json package-lock.json* .npmrc ./
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
ENV AGE_CHECK_OFFLINE=1
RUN npm ci --omit=dev --ignore-scripts --workspace @douyin-tool/server

# Copy built artifacts
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/web/dist ./packages/web/dist

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

USER node
CMD ["node", "packages/server/dist/index.js"]
