# ---------- STAGE 1: Build ----------
FROM oven/bun:1.1.10 AS builder

WORKDIR /app

# Copy everything (including local 'shared' dir)
COPY . .

# Install dependencies (including @shared)
RUN bun install

# Optional: compile TypeScript (adjust to your setup)
# If you're using Bun’s native TS, skip this
RUN bun run build

# ---------- STAGE 2: Production ----------
FROM oven/bun:1.1.10 AS runner

WORKDIR /app

# Copy only the necessary runtime files
COPY --from=builder /app/package.json .
COPY --from=builder /app/bun.lockb .
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/service.config.json .

VOLUME /app/data
# Reinstall only production deps
RUN bun install --production
# Run the app
EXPOSE 25565
CMD ["bun", "dist/index.js"]