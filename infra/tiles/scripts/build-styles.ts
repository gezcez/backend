/**
 * Builds styles/gezcez-light.json and styles/gezcez-dark.json from the Protomaps basemap layers
 * (@protomaps/basemaps), recoloured to the gezcez brand.
 *
 *   bun run styles:build    write both styles
 *   bun run styles:check    fail if the committed styles differ from what this script builds
 *
 * Brand values are copied from the www tokens (_decisions.md section 0): cream #fffbeb, navy
 * #172554, amber-600 #d97706, amber-700 #b45309, amber-400 #fbbf24. Transit features (rail lines,
 * stations, bus stops, ferry terminals, airports) carry the amber accent in both styles.
 *
 * The committed styles point at https://tiles.gezcez.com. The Worker rewrites that origin to the
 * host it is served from, so the same files work on a preview or local `wrangler dev` host.
 */
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type Flavor, layers } from "@protomaps/basemaps"
import { format, resolveConfig } from "prettier"

export const PUBLIC_ORIGIN = "https://tiles.gezcez.com"
const SOURCE = "protomaps"
const LANG = "tr"
const ATTRIBUTION =
	'<a href="https://protomaps.com" target="_blank">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'

const brand = {
	cream: "#fffbeb",
	navy: "#172554",
	navyDeep: "#0b1533",
	amber300: "#fcd34d",
	amber400: "#fbbf24",
	amber600: "#d97706",
	amber700: "#b45309",
	white: "#ffffff",
} as const

/** Mixes `a` into `b`: share 0 is pure `b`, share 1 is pure `a`. Both are #rrggbb. */
export function mix(a: string, b: string, share: number): string {
	const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
	const out = [0, 1, 2].map((i) =>
		Math.round(channel(a, i) * share + channel(b, i) * (1 - share))
			.toString(16)
			.padStart(2, "0"),
	)
	return `#${out.join("")}`
}

type Palette = {
	flavor: Flavor
	/** Text colour of POI labels by group; transit is the amber accent. */
	poi: { transit: string; nature: string; civic: string; other: string; halo: string }
	sprite: string
}

/**
 * The basemap only adds its POI layer when the flavor has a `pois` entry. Its own colours are
 * replaced in recolourPois below; these keep the flavor complete and on-brand.
 */
function poiFlavor(transit: string, nature: string, other: string): NonNullable<Flavor["pois"]> {
	return {
		blue: transit,
		lapis: transit,
		green: nature,
		turquoise: nature,
		pink: other,
		red: other,
		slategray: other,
		tangerine: other,
	}
}

function lightPalette(): Palette {
	const { cream, navy, white, amber600, amber700 } = brand
	const navyOn = (share: number) => mix(navy, cream, share)
	const water = "#cddcea"
	const park = "#e6edcf"
	const casing = navyOn(0.16)
	return {
		sprite: "light",
		poi: {
			transit: amber700,
			nature: "#4d7c3a",
			civic: navyOn(0.7),
			other: navyOn(0.6),
			halo: cream,
		},
		flavor: {
			pois: poiFlavor(amber700, "#4d7c3a", navyOn(0.6)),
			background: cream,
			earth: cream,
			park_a: park,
			park_b: "#dbe7c0",
			hospital: "#fbeee6",
			industrial: navyOn(0.06),
			school: "#fdf1d6",
			wood_a: "#e1ebcc",
			wood_b: "#d3e3b8",
			pedestrian: navyOn(0.04),
			scrub_a: "#e8eed2",
			scrub_b: "#dde8c4",
			glacier: white,
			sand: "#fbf0cf",
			beach: "#fbefc8",
			aerodrome: navyOn(0.07),
			runway: navyOn(0.14),
			water,
			zoo: "#e3eccf",
			military: navyOn(0.08),
			tunnel_other_casing: navyOn(0.1),
			tunnel_minor_casing: navyOn(0.1),
			tunnel_link_casing: navyOn(0.1),
			tunnel_major_casing: navyOn(0.1),
			tunnel_highway_casing: navyOn(0.12),
			tunnel_other: navyOn(0.04),
			tunnel_minor: navyOn(0.04),
			tunnel_link: navyOn(0.04),
			tunnel_major: navyOn(0.04),
			tunnel_highway: navyOn(0.06),
			pier: navyOn(0.08),
			buildings: navyOn(0.09),
			minor_service_casing: casing,
			minor_casing: casing,
			link_casing: casing,
			major_casing_late: navyOn(0.22),
			highway_casing_late: navyOn(0.3),
			other: navyOn(0.05),
			minor_service: white,
			minor_a: navyOn(0.05),
			minor_b: white,
			link: white,
			major_casing_early: navyOn(0.22),
			major: white,
			highway_casing_early: navyOn(0.3),
			highway: navyOn(0.12),
			railway: amber600,
			boundaries: navyOn(0.35),
			bridges_other_casing: casing,
			bridges_minor_casing: casing,
			bridges_link_casing: casing,
			bridges_major_casing: navyOn(0.22),
			bridges_highway_casing: navyOn(0.3),
			bridges_other: navyOn(0.05),
			bridges_minor: white,
			bridges_link: white,
			bridges_major: white,
			bridges_highway: navyOn(0.12),
			roads_label_minor: navyOn(0.6),
			roads_label_minor_halo: white,
			roads_label_major: navyOn(0.75),
			roads_label_major_halo: white,
			ocean_label: mix(navy, water, 0.55),
			subplace_label: navyOn(0.65),
			subplace_label_halo: cream,
			city_label: navy,
			city_label_halo: cream,
			state_label: navyOn(0.45),
			state_label_halo: cream,
			country_label: navyOn(0.6),
			address_label: navyOn(0.55),
			address_label_halo: cream,
			landcover: {
				grassland: "#eef0d4",
				barren: "#fdf3d8",
				urban_area: navyOn(0.05),
				farmland: "#f4f0d2",
				glacier: white,
				scrub: "#ebefd3",
				forest: "#dfe9c8",
			},
		},
	}
}

function darkPalette(): Palette {
	const { navy, navyDeep, cream, amber300, amber400 } = brand
	// Lighten the navy land towards cream for raised features, darken it for water.
	const up = (share: number) => mix(cream, navyDeep, share)
	const water = "#060d22"
	const park = "#0f2133"
	const road = navy
	const casing = "#081029"
	const label = "#fef3c7"
	return {
		sprite: "dark",
		poi: {
			transit: amber300,
			nature: "#8fb98a",
			civic: up(0.6),
			other: up(0.5),
			halo: navyDeep,
		},
		flavor: {
			pois: poiFlavor(amber300, "#8fb98a", up(0.5)),
			background: navyDeep,
			earth: navyDeep,
			park_a: park,
			park_b: "#11283a",
			hospital: "#1a1a3c",
			industrial: up(0.03),
			school: "#171c3a",
			wood_a: "#0e2131",
			wood_b: "#102637",
			pedestrian: up(0.04),
			scrub_a: "#0f1f33",
			scrub_b: "#112335",
			glacier: up(0.1),
			sand: "#1a1d35",
			beach: "#1c1f36",
			aerodrome: up(0.04),
			runway: up(0.12),
			water,
			zoo: "#0f2133",
			military: up(0.04),
			tunnel_other_casing: casing,
			tunnel_minor_casing: casing,
			tunnel_link_casing: casing,
			tunnel_major_casing: casing,
			tunnel_highway_casing: casing,
			tunnel_other: "#111d45",
			tunnel_minor: "#111d45",
			tunnel_link: "#111d45",
			tunnel_major: "#111d45",
			tunnel_highway: "#13214f",
			pier: up(0.08),
			buildings: "#13204a",
			minor_service_casing: casing,
			minor_casing: casing,
			link_casing: casing,
			major_casing_late: casing,
			highway_casing_late: casing,
			other: "#131f4b",
			minor_service: road,
			minor_a: "#131f4b",
			minor_b: road,
			link: "#1c2d63",
			major_casing_early: casing,
			major: "#1c2d63",
			highway_casing_early: casing,
			highway: "#24387a",
			railway: amber400,
			boundaries: up(0.3),
			bridges_other_casing: casing,
			bridges_minor_casing: casing,
			bridges_link_casing: casing,
			bridges_major_casing: casing,
			bridges_highway_casing: casing,
			bridges_other: "#131f4b",
			bridges_minor: road,
			bridges_link: "#1c2d63",
			bridges_major: "#1c2d63",
			bridges_highway: "#24387a",
			roads_label_minor: up(0.45),
			roads_label_minor_halo: navyDeep,
			roads_label_major: up(0.6),
			roads_label_major_halo: navyDeep,
			ocean_label: up(0.35),
			subplace_label: up(0.55),
			subplace_label_halo: navyDeep,
			city_label: label,
			city_label_halo: navyDeep,
			state_label: up(0.35),
			state_label_halo: navyDeep,
			country_label: up(0.5),
			address_label: up(0.45),
			address_label_halo: navyDeep,
			landcover: {
				grassland: "#0f1f34",
				barren: "#141a36",
				urban_area: up(0.03),
				farmland: "#101d35",
				glacier: up(0.1),
				scrub: "#0f1e33",
				forest: "#0d2032",
			},
		},
	}
}

const TRANSIT_KINDS = ["aerodrome", "station", "bus_stop", "ferry_terminal"]
const NATURE_KINDS = ["beach", "forest", "marina", "park", "peak", "zoo", "garden", "bench"]
const CIVIC_KINDS = [
	"stadium",
	"university",
	"library",
	"school",
	"toilets",
	"drinking_water",
	"post_office",
	"townhall",
	"museum",
]

type Layer = ReturnType<typeof layers>[number]

/** Protomaps hard-codes the POI label colours; replace them with the brand groups. */
function recolourPois(list: Layer[], poi: Palette["poi"]): Layer[] {
	return list.map((layer) => {
		if (layer.id !== "pois" || layer.type !== "symbol") return layer
		return {
			...layer,
			paint: {
				...layer.paint,
				"text-color": [
					"case",
					["in", ["get", "kind"], ["literal", TRANSIT_KINDS]],
					poi.transit,
					["in", ["get", "kind"], ["literal", NATURE_KINDS]],
					poi.nature,
					["in", ["get", "kind"], ["literal", CIVIC_KINDS]],
					poi.civic,
					poi.other,
				],
				"text-halo-color": poi.halo,
				"text-halo-width": 1.25,
			},
		}
	})
}

/** Rail lines in the brand amber, solid and a little stronger than the Protomaps default. */
function emphasiseRail(list: Layer[]): Layer[] {
	return list.map((layer) => {
		if (layer.id !== "roads_rail" || layer.type !== "line") return layer
		return { ...layer, paint: { ...layer.paint, "line-opacity": 0.75 } }
	})
}

export function buildStyle(name: "gezcez-light" | "gezcez-dark") {
	const palette = name === "gezcez-light" ? lightPalette() : darkPalette()
	const base = layers(SOURCE, palette.flavor, { lang: LANG })
	return {
		version: 8,
		name,
		metadata: {
			"gezcez:generator": "infra/tiles/scripts/build-styles.ts",
			"gezcez:basemap": "@protomaps/basemaps",
			"gezcez:lang": LANG,
		},
		glyphs: `${PUBLIC_ORIGIN}/fonts/{fontstack}/{range}.pbf`,
		sprite: `${PUBLIC_ORIGIN}/sprites/v4/${palette.sprite}`,
		sources: {
			[SOURCE]: {
				type: "vector",
				url: `${PUBLIC_ORIGIN}/tiles.json`,
				attribution: ATTRIBUTION,
			},
		},
		layers: emphasiseRail(recolourPois(base, palette.poi)),
	}
}

export const STYLE_NAMES = ["gezcez-light", "gezcez-dark"] as const

async function render(name: (typeof STYLE_NAMES)[number], file: string): Promise<string> {
	const config = (await resolveConfig(file)) ?? {}
	return format(JSON.stringify(buildStyle(name)), { ...config, filepath: file })
}

async function main() {
	const check = process.argv.includes("--check")
	const dir = join(import.meta.dir, "..", "styles")
	const stale: string[] = []
	for (const name of STYLE_NAMES) {
		const file = join(dir, `${name}.json`)
		const next = await render(name, file)
		if (check) {
			const current = await readFile(file, "utf8").catch(() => "")
			if (current !== next) stale.push(file)
		} else {
			await writeFile(file, next)
			process.stdout.write(`wrote ${file}\n`)
		}
	}
	if (stale.length > 0) {
		process.stderr.write(
			`Styles are stale, run 'bun run styles:build' in infra/tiles:\n${stale.join("\n")}\n`,
		)
		process.exit(1)
	}
}

if (import.meta.main) await main()
