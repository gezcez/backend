#!/usr/bin/env bash
# Uploads build/turkey.pmtiles to R2: first as a dated copy, then over the live key the Worker
# reads (ARCHIVE_KEY in wrangler.jsonc). Older dated copies stay for rollback:
#
#   aws s3 cp --endpoint-url https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com \
#     s3://gezcez-tiles/basemap/builds/turkey-20260901.pmtiles s3://gezcez-tiles/basemap/turkey.pmtiles
#
# The Worker notices the new ETag within a minute; edge and browser copies of tiles expire within
# a day (TILE_MAX_AGE) and are served stale while they revalidate.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=r2-env.sh
. scripts/r2-env.sh

ARCHIVE="${ARCHIVE:-build/turkey.pmtiles}"
LIVE_KEY="${LIVE_KEY:-basemap/turkey.pmtiles}"
KEEP="${KEEP:-3}"

if [[ ! -f "$ARCHIVE" ]]; then
	echo "$ARCHIVE not found; run 'bun run archive:build' first" >&2
	exit 1
fi
BUILD="$(cat "$ARCHIVE.build" 2>/dev/null || date -u +%Y%m%d)"
DATED_KEY="basemap/builds/turkey-$BUILD.pmtiles"

echo "Uploading $ARCHIVE to s3://$R2_BUCKET_TILES/$DATED_KEY"
r2 cp "$ARCHIVE" "s3://$R2_BUCKET_TILES/$DATED_KEY" \
	--content-type application/vnd.pmtiles --only-show-errors

echo "Publishing it as s3://$R2_BUCKET_TILES/$LIVE_KEY"
r2 cp "s3://$R2_BUCKET_TILES/$DATED_KEY" "s3://$R2_BUCKET_TILES/$LIVE_KEY" --only-show-errors

# Keep the newest $KEEP dated builds.
r2 ls "s3://$R2_BUCKET_TILES/basemap/builds/" | awk '{print $4}' | grep '^turkey-[0-9]\{8\}\.pmtiles$' |
	sort | awk -v keep="$KEEP" '{ a[NR] = $0 } END { for (i = 1; i <= NR - keep; i++) print a[i] }' |
	while read -r old; do
		echo "Removing old build $old"
		r2 rm "s3://$R2_BUCKET_TILES/basemap/builds/$old" --only-show-errors
	done

echo "Done. Check https://tiles.gezcez.com/tiles.json in a minute."
