# gezcez backend

The gezcez API: OAuth 2.1 authorization server, dashboard API, mobile API and public transit API.
NestJS 11 on Bun, SQLite through Drizzle (`bun:sqlite`), zod validation, OpenAPI 3.1.

This repository stands alone. It shares no package with the client repos (`gezcez/oauth`,
`gezcez/dashboard`, `gezcez/mobile`); they consume it through the published `openapi.json` and the
`ghcr.io/gezcez/backend` Docker image.

## Quick start

```sh
bun install
cp .env.example .env   # optional, every value has a development default
bun run dev            # http://localhost:8080
```

- `GET /health` process is up, `GET /ready` databases open and migrated (503 otherwise)
- `GET /docs` API reference (Scalar), `GET /openapi.json` the contract clients generate from
- Everything else lives under `/v1`

Migrations run at boot. `bun run db:seed` loads the idempotent seed for the current environment
(`--env production|staging|local|test` to override).

## Scripts

| Script                             | What it does                                                     |
| ---------------------------------- | ---------------------------------------------------------------- |
| `dev`                              | Run `src/main.ts` with watch                                     |
| `start`                            | Run `src/main.ts` (Bun runs TypeScript directly; no bundle)      |
| `typecheck`                        | `tsc --noEmit`                                                   |
| `lint` / `format`                  | ESLint (with the rules in `eslint-rules/`) and Prettier          |
| `test`                             | Unit specs (`src/**/*.spec.ts`) then e2e (`test/e2e/*.e2e.ts`)   |
| `test:smoke`                       | Code flow against `SMOKE_BASE_URL` (or an in-process app)        |
| `db:generate`                      | Generate a migration from `src/schemas/core` into `drizzle/core` |
| `db:migrate` / `db:seed`           | Apply migrations / seed without starting the server              |
| `openapi:export` / `openapi:check` | Write `openapi.json` / fail if the committed copy is stale       |

## Layout

```
src/
  main.ts               bootstrap only
  app.factory.ts        builds the configured app (used by main, tests and scripts)
  app.module.ts         root module
  common/               config, errors, response envelope, logger, OpenAPI builder
    middlewares/        guards, decorators, filters, interceptors
    utils/              small helpers without global state
  db/                   database module, SQLite opener, boot migrations
  schemas/core/         core.db tables (one file per table group, barrel in index.ts)
  services/<domain>/    <domain>.module|controller|service|repository|dto|spec.ts
  lang/                 tr/en strings for emails
  ws/                   WebSocket gateways
drizzle/core/           generated SQL migrations (committed)
eslint-rules/           repositories-only, no-orm-in-controllers, drizzle imports-only
scripts/                seed, migrate, export-openapi
infra/tiles/            tiles.gezcez.com Worker, map styles and basemap build (own package)
test/helpers/app.ts     boots the real app on a temp DATA_DIR for e2e tests
```

Rules enforced by lint: only `*.repository.ts` files import the database module (`@db`);
controllers and services never import `drizzle-orm` or `@schemas`; only SQLite flavoured drizzle
entry points are allowed.

## Responses and errors

Handlers return plain data and the response interceptor wraps it:

```json
{ "ok": true, "data": { "...": "..." } }
{ "ok": false, "error": { "code": "VALIDATION_FAILED", "message": "...", "details": {}, "request_id": "01J..." } }
```

Error codes and their HTTP statuses live in `src/common/errors.ts` and are published as the
`ErrorCode` enum in `openapi.json`. `request_id` equals the `x-request-id` response header. The
OAuth protocol endpoints (`/v1/oauth/token`, `/v1/oauth/revoke`, `/.well-known/*`) and the probes
return their standard shapes without the envelope.

## Configuration

Every environment variable is listed with a comment in `.env.example` and validated by zod at
boot (`src/common/config.ts`). It fails closed: staging and production refuse to start without
`KEY_ENCRYPTION_SECRET`, `SEAL_SECRET`, `CODE_PEPPER`, `CSRF_SECRET`, `TURNSTILE_SECRET` and
`EMAIL_TRANSPORT=ses` with `SES_REGION`; development refuses the built-in dev secrets unless
`PUBLIC_API_URL` is loopback; `STAGING_TEST_OTP` is refused with `NODE_ENV=production` or on the
`api.gezcez.com` host (compared by hostname).

## Docker

```sh
docker build -t gezcez-backend .
docker run --rm -p 8080:8080 -v gezcez-data:/app/data \
  -e NODE_ENV=development gezcez-backend
```

The image runs as a non-root user, keeps all state in `/app/data` and has a health check on
`/health`. `compose.yml` runs the same image locally (`docker compose up --build`).

## Deploy

`deploy/compose.yml` runs the published image behind a Cloudflare tunnel (no open ports) with
Litestream replicating `core.db` to R2 (`litestream.yml`); a one-shot `restore` service
restores from R2 when the volume is empty. Copy `deploy/.env.example` to `deploy/.env`, add
`deploy/cloudflared-credentials.json`, then `docker compose up -d` in `deploy/`.
`deploy/restore.md` is the restore runbook.

## Tile service

`infra/tiles/` holds the basemap the mobile app and the dashboard share: a Protomaps Turkey
extract on R2 behind a Cloudflare Worker at `tiles.gezcez.com`, the `gezcez-light` and
`gezcez-dark` MapLibre styles, and the build and upload scripts. It is a separate package with its
own lockfile and workflow (`.github/workflows/tiles.yml`, deployed by `tiles-v*` tags). Setup and
operation: [infra/tiles/README.md](infra/tiles/README.md).

## Test mode for client e2e suites

Client repos (oauth, dashboard, mobile) run their e2e suites against the published image:

```sh
docker run --rm -p 8080:8080 -e NODE_ENV=test -e PUBLIC_API_URL=http://localhost:8080 \
  ghcr.io/gezcez/backend:v<x.y.z>
```

With `NODE_ENV=test` the boot seeds the `e2e_client` (first-party) and `e2e_third_party`
clients (redirect `http://localhost:4710/callback`, post-logout `http://localhost:4710/`),
fixture users (`root@`, `admin@`, `moderator@`, `netadmin@`, `analyst@` and `rider@`
`test.gezcez.com`), the Kocaeli city and two networks. Mail goes to memory, and
`GET /v1/__test/mailbox?to=<address>` returns the codes. The identity UI origin defaults to
`http://localhost:5174` (`OAUTH_UI_URL`). CI runs `test/smoke/code-flow.smoke.ts` against the
image (`SMOKE_BASE_URL=http://localhost:8080 bun run test:smoke`) before publishing it.

## Contract publishing

- `openapi.json` is committed at the root; CI fails when it is stale (`bun run openapi:export`).
- CI on `main` pushes `ghcr.io/gezcez/backend:main` and `:sha-<sha>` after the smoke test.
- Pull requests run `oasdiff breaking` against the base branch's `openapi.json`; a PR that
  breaks the contract on purpose carries the `api-breaking` label.
- A `v*` tag attaches `openapi.json` to the GitHub release and pushes `:v<x.y.z>` and `:latest`,
  so client repos can pin an exact contract version for `api:gen` and their e2e suites.
