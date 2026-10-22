# Restore runbook

core.db is replicated by Litestream to R2 every 10 s (30 days of history). This is the only
place its data lives besides the VPS disk.

## New host or lost volume

1. Install Docker, copy `deploy/` with its `.env` and `cloudflared-credentials.json`.
2. `docker compose up -d`. The `restore` service runs first: with an empty volume and a replica
   in R2 it restores `/data/core.db`, then the backend starts and applies any newer migrations.
3. Check `https://api.gezcez.com/ready` and sign in to the dashboard.

## Restore to a point in time (bad migration, bad write)

1. `docker compose stop backend litestream`
2. Restore into a scratch file and inspect it first:
   `docker compose run --rm restore restore -o /data/core.restored.db -timestamp 2026-10-22T10:00:00Z /data/core.db`
3. Boot a throwaway backend against it (`DATA_DIR` pointing at a copy) and run the smoke test:
   `SMOKE_BASE_URL=http://localhost:8080 bun run test:smoke`.
4. Move the current file aside (`core.db`, `core.db-wal`, `core.db-shm` to `*.broken`), rename
   `core.restored.db` to `core.db`, then `docker compose up -d`.

## Drill

Monthly: run step 2 and 3 of the point-in-time restore against the latest replica and record
the date and the time it took in the ops log.
