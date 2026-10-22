# syntax=docker/dockerfile:1.7
# gezcez backend image: ghcr.io/gezcez/backend
ARG BUN_VERSION=1.4.2

# ---------- dependencies (production only) ----------
FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# ---------- runtime ----------
FROM oven/bun:${BUN_VERSION}-slim AS runtime
ARG GIT_SHA=dev
ARG BUILD_TIME=
LABEL org.opencontainers.image.source="https://github.com/gezcez/backend" \
      org.opencontainers.image.description="gezcez API"
ENV NODE_ENV=production \
    MODE=all \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/app/data \
    MIGRATIONS_DIR=/app/drizzle \
    GIT_SHA=${GIT_SHA} \
    BUILD_TIME=${BUILD_TIME}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Bun runs the TypeScript sources directly. Its bundler applies TC39 decorators to files reached
# through tsconfig path aliases, which breaks Nest's method decorators, so there is no bundle.
COPY package.json tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
RUN mkdir -p /app/data && chown bun:bun /app/data
USER bun
VOLUME ["/app/data"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["bun", "src/main.ts"]
