#!/usr/bin/env bash
# Uploads map glyphs and sprites to R2 under assets/ (ASSETS_PREFIX in wrangler.jsonc), where the
# Worker serves them as /fonts/{fontstack}/{range}.pbf and /sprites/v4/{light,dark}[@2x].{json,png}.
#
# Source: github.com/protomaps/basemaps-assets, the prebuilt Noto Sans glyph ranges and the v4
# sprites the Protomaps layers reference. Pinned to a commit so a rebuild never changes icons by
# surprise. Run once at setup and again only when the pin moves.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=r2-env.sh
. scripts/r2-env.sh

ASSETS_REPO="${ASSETS_REPO:-https://github.com/protomaps/basemaps-assets.git}"
ASSETS_REF="${ASSETS_REF:-main}"
WORK="build/basemaps-assets"

rm -rf "$WORK"
git clone --quiet --filter=blob:none --no-checkout "$ASSETS_REPO" "$WORK"
git -C "$WORK" sparse-checkout set --no-cone /fonts/ /sprites/v4/
git -C "$WORK" checkout --quiet "$ASSETS_REF"
echo "basemaps-assets at $(git -C "$WORK" rev-parse HEAD)"

r2 sync "$WORK/fonts" "s3://$R2_BUCKET_TILES/assets/fonts" \
	--content-type application/x-protobuf --only-show-errors
r2 sync "$WORK/sprites/v4" "s3://$R2_BUCKET_TILES/assets/sprites/v4" \
	--exclude "*" --include "*.json" --content-type application/json --only-show-errors
r2 sync "$WORK/sprites/v4" "s3://$R2_BUCKET_TILES/assets/sprites/v4" \
	--exclude "*" --include "*.png" --content-type image/png --only-show-errors

echo "Uploaded fonts and sprites to s3://$R2_BUCKET_TILES/assets/"
