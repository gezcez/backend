# tiles.gezcez.com

The gezcez basemap: an OpenStreetMap vector tile archive built by Protomaps, extracted for Turkey,
stored as one PMTiles file in the R2 bucket `gezcez-tiles` and served by a Cloudflare Worker. The
mobile app and the dashboard both use it through the `gezcez-light` and `gezcez-dark` styles
(backend plan 12.1). This folder is a standalone package with its own lockfile; nothing in `src/`
imports it and it imports nothing from there.

```
src/index.ts            router, edge cache, conditional requests, raw archive with Range
src/archive.ts          PMTiles over R2 (ETag-conditional range reads), header/directory cache
src/cors.ts             CORS for gezcez origins
src/styles.ts           serves the generated styles, rewritten to the serving host
styles/*.json           generated MapLibre styles (committed)
scripts/build-styles.ts generates the styles from @protomaps/basemaps with brand colours
scripts/build-archive.sh   extracts Turkey from a Protomaps daily build (pmtiles CLI)
scripts/upload-archive.sh  uploads the archive to R2 (dated copy, then the live key)
scripts/upload-assets.sh   uploads glyphs and sprites to R2
test/                   Worker tests in the Workers runtime (vitest + @cloudflare/vitest-plugin)
```

## Endpoints

| Path                                            | What                                                        | Cache-Control           |
| ----------------------------------------------- | ----------------------------------------------------------- | ----------------------- |
| `/{z}/{x}/{y}.mvt` (or `.pbf`)                  | Vector tile. Empty body where the archive has none          | 1 day + 7 d stale (\*)  |
| `/tiles.json`                                   | TileJSON 3.0 (bounds, zooms, vector layers, attribution)    | 1 hour + 7 d stale      |
| `/styles/gezcez-light.json`, `gezcez-dark.json` | MapLibre styles, URLs pointing at the host that served them | 1 hour + 7 d stale      |
| `/fonts/{fontstack}/{range}.pbf`                | Glyph ranges from R2 `assets/fonts/`                        | 7 days + 7 d stale      |
| `/sprites/v4/{light,dark}[@2x].{json,png}`      | Sprites from R2 `assets/sprites/v4/`                        | 7 days + 7 d stale      |
| `/basemap.pmtiles`                              | The raw archive, single `Range` requests answered with 206  | 1 hour, not edge-cached |
| `/health`                                       | `{"ok":true}`                                               | no-store                |

(\*) `TILE_MAX_AGE` in `wrangler.jsonc`. Every 200 except the raw archive is stored in the
Cloudflare cache by URL, and carries an `ETag` that `If-None-Match` answers with 304. Tiles out of
the archive's zoom range are 404, addresses outside the tile grid 400, and while no archive is
uploaded tile and TileJSON requests are 503. Errors are `{"code","message"}` JSON with
`no-store`.

CORS: `ALLOWED_ORIGINS` lists exact origins and `https://*.gezcez.com` (one subdomain level, so
`dash.gezcez.com` and `dash-staging.gezcez.com`), plus the dashboard and Expo dev servers on
localhost. CORS headers are added after the cache, so one cached tile serves every origin. Native
mobile requests send no Origin and need none.

When the archive is replaced the Worker notices within a minute (reads are conditional on the
archive's ETag, and the cached header is re-read every 60 s). Tiles already in the edge cache or
a browser keep their old content until `TILE_MAX_AGE` passes, which is fine for a monthly rebuild.

## Styles

`bun run styles:build` regenerates `styles/gezcez-light.json` and `styles/gezcez-dark.json` from
the Protomaps basemap layers (`@protomaps/basemaps`, Turkish labels with Latin fallbacks) using two
custom flavors in `scripts/build-styles.ts`. CI fails when the committed files are stale
(`bun run styles:check`). Colours follow the www tokens:

| Element                              | gezcez-light                  | gezcez-dark                     |
| ------------------------------------ | ----------------------------- | ------------------------------- |
| Land, background                     | cream `#fffbeb`               | navy `#0b1533`                  |
| Roads                                | white, navy-tinted casings    | navy `#172554` and lighter navy |
| Motorways                            | light navy tint               | `#24387a`                       |
| Place and road labels                | navy `#172554` on cream halos | amber-100 `#fef3c7` on navy     |
| Water                                | muted blue-grey `#cddcea`     | `#060d22`                       |
| Rail lines                           | amber-600 `#d97706`           | amber-400 `#fbbf24`             |
| Station, stop, ferry, airport labels | amber-700 `#b45309`           | amber-300 `#fcd34d`             |

The committed styles use `https://tiles.gezcez.com` for the source, glyphs and sprite; the Worker
rewrites that to its own origin, so `wrangler dev` and preview hosts are self-contained. The
dashboard's denser variant is derived in the dashboard repo from these files.

Clients: mobile reads the style URL from `/v1/app/config` (`tiles_style_url`, light and dark),
the dashboard from `VITE_MAP_STYLE_LIGHT` / `VITE_MAP_STYLE_DARK`. OpenFreeMap stays the fallback
in both. The attribution (Protomaps, © OpenStreetMap, ODbL) comes with the source and must stay
visible.

## Glyphs and sprites

Hosted in the same bucket under `assets/` and uploaded once with `bun run assets:upload` from
[protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets) (pin `ASSETS_REF` to a
commit):

- Glyphs: the prebuilt Noto Sans ranges the Protomaps layers reference (`Noto Sans Regular`,
  `Medium`, `Italic`, and `Devanagari Regular v1` for its script fallback), about 70 MB in
  256-codepoint PBF ranges. Noto covers every script that shows up in Turkey's OSM names, which
  Inter does not.
- Sprites: the Protomaps v4 `light` and `dark` sheets, 1x and 2x.
- Later, optional: Inter glyphs for Latin labels to match the brand (build PBF ranges with
  `build_pbf_glyphs` or `font-maker`, upload as `assets/fonts/Inter Regular/...`, and change the
  `text-font` stacks in `build-styles.ts` to `["Inter Regular", "Noto Sans Regular"]`), and a
  gezcez sprite sheet with amber transit icons (`spreet` over recoloured Protomaps SVGs, uploaded as
  `assets/sprites/v4/gezcez-light|dark`). Both are config-only changes to the styles.

## Local development

```sh
bun install
bun run typecheck      # wrangler types into node_modules/.types, then tsc
bun run test           # Worker tests in workerd with a local R2 and Cache API
bun run dev            # wrangler dev on http://localhost:8787 with a local R2 bucket
```

For real tiles locally, extract a small area and put it in the local bucket:

```sh
BBOX=29.3,40.5,30.4,41.2 MAXZOOM=14 bun run archive:build     # Kocaeli, a few MB
bunx wrangler r2 object put gezcez-tiles/basemap/turkey.pmtiles --file build/turkey.pmtiles --local
open http://localhost:8787/tiles.json
```

Point MapLibre at `http://localhost:8787/styles/gezcez-light.json` (labels need the glyphs in the
local bucket too; upload a few ranges with `wrangler r2 object put --local` or use a remote
`glyphs` URL while testing).

## Building the basemap

`bun run archive:build` (scripts/build-archive.sh) downloads the `pmtiles` CLI if it is not on
`PATH` (Linux; `brew install pmtiles` on macOS), finds the latest Protomaps daily build from
`build-metadata.protomaps.dev`, and runs `pmtiles extract` with the Turkey bounding box
`25.6,35.8,44.9,42.2` up to zoom 15. `extract` reads only the byte ranges it needs from the remote
planet, so it transfers roughly the size of the result (1 to 2 GB). The output is
`build/turkey.pmtiles` plus `build/turkey.pmtiles.build` with the build date. Override with
`BUILD=YYYYMMDD`, `BBOX`, `MAXZOOM`, `PMTILES_VERSION` or `PMTILES_BIN`. Planet coverage later is
the same script with no `--bbox` (about 120 GB on R2, still cents per GB-month).

`bun run archive:upload` puts it at `basemap/builds/turkey-<build>.pmtiles`, copies that over the
live key `basemap/turkey.pmtiles` (`ARCHIVE_KEY`), and keeps the newest three dated builds.
Rollback is a copy of an older dated build over the live key (the command is in the script header).

These run on a workstation or in the `rebuild` job of `.github/workflows/tiles.yml`; the `check`
job never downloads anything.

## One-time setup

Cloudflare (account that owns the `gezcez.com` zone):

1. R2: create the bucket `gezcez-tiles` (location hint Eastern Europe). Keep public access off;
   only the Worker reads it.
2. R2 API token: R2 → Manage API tokens → create an Account API token with **Object Read & Write**
   scoped to `gezcez-tiles`. Note the access key id and secret (S3 credentials for the scripts).
3. API token for deploys: My Profile → API Tokens → custom token with **Account / Workers Scripts:
   Edit**, **Account / Workers R2 Storage: Read** (binding check), **Zone / Workers Routes: Edit**
   and **Zone / DNS: Edit** on `gezcez.com` (the custom domain creates its own DNS record).
4. DNS: nothing by hand. `routes` in `wrangler.jsonc` declares `tiles.gezcez.com` as a Worker
   custom domain, so the first deploy creates the proxied record and certificate. Remove any
   existing `tiles` record first, or the deploy refuses.
5. Compression: Rules → Compression Rules → new rule, "Hostname equals tiles.gezcez.com", enable
   Brotli and Gzip for all content types (or add `application/vnd.mapbox-vector-tile` to the
   custom list). The Worker sends tiles uncompressed and the edge compresses them, about 3x.
6. Bot Fight Mode must not challenge `tiles.gezcez.com` (it breaks the mobile app's tile loads);
   if it is on for the zone, skip it for this hostname with a WAF skip rule.

GitHub (`gezcez/backend` → Settings):

1. Environment `tiles` (optionally with required reviewers) with secrets:
    - `CLOUDFLARE_API_TOKEN`: the deploy token from step 3
    - `CLOUDFLARE_ACCOUNT_ID`: the account id (also the R2 endpoint's account)
    - `R2_TILES_ACCESS_KEY_ID`, `R2_TILES_SECRET_ACCESS_KEY`: the R2 token from step 2
2. Repository variable `TILES_REBUILD_ENABLED=true` once the first manual rebuild worked, to turn
   on the monthly schedule (the 2nd of each month, 03:00 UTC).

First launch, from a workstation with the same credentials exported as `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`:

```sh
bun install
bun run assets:upload      # glyphs and sprites
bun run archive:build      # or run the "tiles" workflow by hand (rebuild job)
bun run archive:upload
git tag tiles-v0.1.0 && git push origin tiles-v0.1.0     # deploys the Worker
curl https://tiles.gezcez.com/tiles.json
```

Then set `tiles_style_url` in the backend's app config and the dashboard's style env vars to
`https://tiles.gezcez.com/styles/gezcez-light.json` and `.../gezcez-dark.json`.

## Releases

A `tiles-v*` tag runs the checks and `wrangler deploy` (environment `tiles`), then smoke-tests
`/health` and a style. Backend `v*` release tags do not deploy the Worker. Style changes ship with
a Worker deploy (the styles are bundled); basemap data changes need no deploy.

Costs: a Turkey archive is 1 to 2 GB of R2 storage (cents per month), R2 has no egress fees, and
most tile requests are answered from the edge cache without an R2 read or much Worker CPU.
