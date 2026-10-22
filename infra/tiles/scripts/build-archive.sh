#!/usr/bin/env bash
# Extracts the Turkey basemap from a Protomaps daily planet build into build/turkey.pmtiles.
#
#   bun run archive:build                       latest daily build, Turkey bbox, zooms 0-15
#   BUILD=20261020 bun run archive:build        a specific daily build
#   BBOX=26.0,40.2,30.6,41.6 MAXZOOM=14 ...     a smaller area for a quick local test
#
# pmtiles extract reads only the byte ranges it needs from the remote planet over HTTP, so this
# downloads about the size of the output (1 to 2 GB for Turkey), not the 100+ GB planet. It needs
# network access to build.protomaps.com and github.com; it is not run in CI (see README.md).
set -euo pipefail

cd "$(dirname "$0")/.."

# Turkey with a small margin (Edirne to Hakkari, the Black Sea coast to Hatay).
BBOX="${BBOX:-25.6,35.8,44.9,42.2}"
MAXZOOM="${MAXZOOM:-15}"
PMTILES_VERSION="${PMTILES_VERSION:-1.28.0}"
OUT_DIR="${OUT_DIR:-build}"
OUT="${OUT:-$OUT_DIR/turkey.pmtiles}"
BUILDS_URL="https://build.protomaps.com"
BUILDS_INDEX="https://build-metadata.protomaps.dev/builds.json"

mkdir -p "$OUT_DIR"

pmtiles_bin() {
	if [[ -n "${PMTILES_BIN:-}" ]]; then
		echo "$PMTILES_BIN"
	elif command -v pmtiles >/dev/null 2>&1; then
		command -v pmtiles
	else
		local os arch archive dest="$OUT_DIR/bin"
		case "$(uname -s)" in
			Linux) os=Linux ;;
			Darwin) os=Darwin ;;
			*) echo "Install pmtiles (https://github.com/protomaps/go-pmtiles) and set PMTILES_BIN" >&2; exit 1 ;;
		esac
		case "$(uname -m)" in
			x86_64 | amd64) arch=x86_64 ;;
			arm64 | aarch64) arch=arm64 ;;
			*) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;;
		esac
		if [[ ! -x "$dest/pmtiles" ]]; then
			if [[ "$os" != Linux ]]; then
				echo "Install pmtiles (brew install pmtiles) or set PMTILES_BIN" >&2
				exit 1
			fi
			mkdir -p "$dest"
			archive="go-pmtiles_${PMTILES_VERSION}_${os}_${arch}.tar.gz"
			curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/${archive}" |
				tar -xz -C "$dest" pmtiles
		fi
		echo "$dest/pmtiles"
	fi
}

latest_build() {
	# builds.json lists the daily builds as {"key": "YYYYMMDD.pmtiles", ...}.
	curl -fsSL "$BUILDS_INDEX" | grep -o '"key": *"[0-9]\{8\}\.pmtiles"' | grep -o '[0-9]\{8\}' | sort | tail -1
}

BUILD="${BUILD:-$(latest_build)}"
if [[ -z "$BUILD" ]]; then
	echo "Could not find the latest build at $BUILDS_INDEX; set BUILD=YYYYMMDD" >&2
	exit 1
fi

PMTILES="$(pmtiles_bin)"
SOURCE="$BUILDS_URL/$BUILD.pmtiles"
echo "Extracting $BBOX (z0-$MAXZOOM) from $SOURCE"
"$PMTILES" extract "$SOURCE" "$OUT" --bbox="$BBOX" --maxzoom="$MAXZOOM" --download-threads=8
"$PMTILES" verify "$OUT"
"$PMTILES" show "$OUT"

# Remember which build the archive came from; upload-archive.sh names the dated copy after it.
echo "$BUILD" >"$OUT.build"
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1)) from build $BUILD"
