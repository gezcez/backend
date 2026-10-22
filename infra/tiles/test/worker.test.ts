import { env, exports } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { forgetArchives } from "../src/archive"
import { buildPmtiles, bytes } from "./fixture"

// Every test gets its own host so edge-cache entries from one test never answer another.
let host = ""
let counter = 0
const call = (path: string, init?: RequestInit) =>
	exports.default.fetch(new Request(`https://${host}${path}`, init))

const ARCHIVE = env.ARCHIVE_KEY
const text = async (res: Response) => new TextDecoder().decode(await res.arrayBuffer())
const DASH = "https://dash.gezcez.com"

async function putArchive(gzip = false) {
	const archive = await buildPmtiles({
		gzip,
		minZoom: 0,
		maxZoom: 14,
		tiles: [
			{ z: 0, x: 0, y: 0, data: bytes("world") },
			{ z: 6, x: 37, y: 24, data: bytes("istanbul-z6") },
			{ z: 14, x: 9640, y: 6140, data: bytes("izmit-z14") },
		],
	})
	await env.BUCKET.put(ARCHIVE, archive)
	return archive
}

beforeEach(async () => {
	counter += 1
	host = `t${counter}.tiles.test`
	await env.BUCKET.delete(ARCHIVE)
	forgetArchives()
})

describe("tiles", () => {
	it("serves a tile with vector tile headers and edge-cache friendly caching", async () => {
		await putArchive()
		const res = await call("/6/37/24.mvt")
		expect(res.status).toBe(200)
		expect(res.headers.get("Content-Type")).toBe("application/vnd.mapbox-vector-tile")
		expect(res.headers.get("Cache-Control")).toBe(
			"public, max-age=86400, stale-while-revalidate=604800",
		)
		expect(res.headers.get("ETag")).toMatch(/^".+"$/)
		expect(await text(res)).toBe("istanbul-z6")
	})

	it("decompresses gzip tiles from the archive", async () => {
		await putArchive(true)
		const res = await call("/14/9640/6140.mvt")
		expect(res.status).toBe(200)
		expect(await text(res)).toBe("izmit-z14")
	})

	it("accepts the .pbf extension too", async () => {
		await putArchive()
		const res = await call("/0/0/0.pbf")
		expect(await text(res)).toBe("world")
	})

	it("answers an empty, cacheable tile where the archive has none", async () => {
		await putArchive()
		for (let i = 0; i < 2; i++) {
			const res = await call("/6/0/0.mvt")
			expect(res.status).toBe(200)
			expect(res.headers.get("Cache-Control")).toContain("max-age=86400")
			expect((await res.arrayBuffer()).byteLength).toBe(0)
		}
	})

	it("answers 404 outside the archive zoom range and 400 outside the tile grid", async () => {
		await putArchive()
		expect((await call("/15/0/0.mvt")).status).toBe(404)
		const bad = await call("/2/4/0.mvt")
		expect(bad.status).toBe(400)
		expect(await bad.json()).toMatchObject({ code: "BAD_REQUEST" })
	})

	it("answers 503 while no archive is uploaded", async () => {
		const res = await call("/1/0/0.mvt")
		expect(res.status).toBe(503)
		expect(res.headers.get("Cache-Control")).toBe("no-store")
		expect(await res.json()).toMatchObject({ code: "ARCHIVE_UNAVAILABLE" })
	})

	it("answers If-None-Match with 304", async () => {
		await putArchive()
		const first = await call("/0/0/0.mvt")
		const etag = first.headers.get("ETag") ?? ""
		const again = await call("/0/0/0.mvt", { headers: { "If-None-Match": etag } })
		expect(again.status).toBe(304)
	})

	it("picks up a replaced archive without a restart", async () => {
		await putArchive()
		expect(await text(await call("/0/0/0.mvt"))).toBe("world")
		await env.BUCKET.put(
			ARCHIVE,
			await buildPmtiles({ tiles: [{ z: 0, x: 0, y: 0, data: bytes("rebuilt") }] }),
		)
		host = `fresh-${host}`
		expect(await text(await call("/0/0/0.mvt"))).toBe("rebuilt")
	})

	it("returns no body for HEAD", async () => {
		await putArchive()
		const res = await call("/0/0/0.mvt", { method: "HEAD" })
		expect(res.status).toBe(200)
		expect(await text(res)).toBe("")
	})
})

describe("tilejson", () => {
	it("describes the archive with tile URLs on the serving host", async () => {
		await putArchive()
		const res = await call("/tiles.json")
		expect(res.status).toBe(200)
		expect(res.headers.get("Cache-Control")).toContain("max-age=3600")
		const json = (await res.json()) as Record<string, unknown>
		expect(json).toMatchObject({
			tilejson: "3.0.0",
			tiles: [`https://${host}/{z}/{x}/{y}.mvt`],
			minzoom: 0,
			maxzoom: 14,
			bounds: [25.6, 35.8, 44.9, 42.2],
			vector_layers: [{ id: "earth", fields: {} }],
		})
		expect(json.attribution).toContain("OpenStreetMap")
	})
})

describe("styles", () => {
	it.each(["gezcez-light", "gezcez-dark"])(
		"serves %s rewritten to the serving host",
		async (name) => {
			const res = await call(`/styles/${name}.json`)
			expect(res.status).toBe(200)
			const style = (await res.json()) as {
				name: string
				glyphs: string
				sprite: string
				sources: { protomaps: { url: string; attribution: string } }
				layers: { id: string }[]
			}
			expect(style.name).toBe(name)
			expect(style.glyphs).toBe(`https://${host}/fonts/{fontstack}/{range}.pbf`)
			expect(style.sprite).toMatch(new RegExp(`^https://${host}/sprites/v4/(light|dark)$`))
			expect(style.sources.protomaps.url).toBe(`https://${host}/tiles.json`)
			expect(style.sources.protomaps.attribution).toContain("OpenStreetMap")
			expect(style.layers.length).toBeGreaterThan(50)
		},
	)

	it("uses the brand colours", async () => {
		const light = await text(await call("/styles/gezcez-light.json"))
		const dark = await text(await call("/styles/gezcez-dark.json"))
		expect(light).toContain("#fffbeb") // cream land
		expect(light).toContain("#172554") // navy labels
		expect(light).toContain("#d97706") // amber rail
		expect(dark).toContain("#0b1533") // navy land
		expect(dark).toContain("#fcd34d") // amber transit labels
	})

	it("404s an unknown style", async () => {
		expect((await call("/styles/osm-bright.json")).status).toBe(404)
	})
})

describe("glyphs and sprites", () => {
	it("serves glyph ranges and sprites from the assets prefix", async () => {
		await env.BUCKET.put(`${env.ASSETS_PREFIX}fonts/Noto Sans Regular/0-255.pbf`, "glyphs")
		await env.BUCKET.put(`${env.ASSETS_PREFIX}sprites/v4/light@2x.png`, "png")
		const font = await call("/fonts/Noto%20Sans%20Regular/0-255.pbf")
		expect(font.status).toBe(200)
		expect(font.headers.get("Content-Type")).toBe("application/x-protobuf")
		expect(font.headers.get("Cache-Control")).toContain("max-age=604800")
		expect(await text(font)).toBe("glyphs")
		const sprite = await call("/sprites/v4/light@2x.png")
		expect(sprite.headers.get("Content-Type")).toBe("image/png")
		expect(await text(sprite)).toBe("png")
	})

	it("404s a missing asset and does not cache the miss", async () => {
		const miss = await call("/fonts/Inter%20Regular/0-255.pbf")
		expect(miss.status).toBe(404)
		await env.BUCKET.put(`${env.ASSETS_PREFIX}fonts/Inter Regular/0-255.pbf`, "inter")
		expect((await call("/fonts/Inter%20Regular/0-255.pbf")).status).toBe(200)
	})
})

describe("raw archive", () => {
	it("serves byte ranges with 206 and Content-Range", async () => {
		const archive = await putArchive()
		const res = await call("/basemap.pmtiles", { headers: { Range: "bytes=0-6" } })
		expect(res.status).toBe(206)
		expect(res.headers.get("Accept-Ranges")).toBe("bytes")
		expect(res.headers.get("Content-Range")).toBe(`bytes 0-6/${archive.length}`)
		expect(await text(res)).toBe("PMTiles")
	})

	it("serves suffix ranges and the whole archive", async () => {
		const archive = await putArchive()
		const tail = await call("/basemap.pmtiles", { headers: { Range: "bytes=-9" } })
		expect(tail.status).toBe(206)
		expect(await text(tail)).toBe("izmit-z14")
		const whole = await call("/basemap.pmtiles")
		expect(whole.status).toBe(200)
		expect((await whole.arrayBuffer()).byteLength).toBe(archive.length)
	})

	it("answers 416 for an unsatisfiable range", async () => {
		const archive = await putArchive()
		const res = await call("/basemap.pmtiles", {
			headers: { Range: `bytes=${archive.length}-` },
		})
		expect(res.status).toBe(416)
		expect(res.headers.get("Content-Range")).toBe(`bytes */${archive.length}`)
	})

	it("answers HEAD with the length and If-None-Match with 304", async () => {
		const archive = await putArchive()
		const head = await call("/basemap.pmtiles", { method: "HEAD" })
		expect(head.status).toBe(200)
		expect(head.headers.get("Content-Length")).toBe(String(archive.length))
		const etag = head.headers.get("ETag") ?? ""
		const again = await call("/basemap.pmtiles", { headers: { "If-None-Match": etag } })
		expect(again.status).toBe(304)
		const stale = await call("/basemap.pmtiles", { headers: { "If-Match": '"other"' } })
		expect(stale.status).toBe(412)
	})
})

describe("cors", () => {
	it("allows gezcez origins", async () => {
		await putArchive()
		const res = await call("/0/0/0.mvt", { headers: { Origin: DASH } })
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(DASH)
		expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Content-Range")
		expect(res.headers.get("Vary")).toContain("Origin")
	})

	it("serves a cached tile with the right origin for each caller", async () => {
		await putArchive()
		await call("/0/0/0.mvt", { headers: { Origin: DASH } })
		const res = await call("/0/0/0.mvt", { headers: { Origin: "https://gezcez.com" } })
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://gezcez.com")
	})

	it("ignores other origins and nested subdomains", async () => {
		for (const origin of [
			"https://evil.example",
			"https://a.b.gezcez.com",
			"http://dash.gezcez.com",
		]) {
			const res = await call("/styles/gezcez-light.json", { headers: { Origin: origin } })
			expect(res.status).toBe(200)
			expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull()
		}
	})

	it("answers preflight for allowed origins with the requested safe headers", async () => {
		const res = await call("/basemap.pmtiles", {
			method: "OPTIONS",
			headers: {
				Origin: DASH,
				"Access-Control-Request-Method": "GET",
				"Access-Control-Request-Headers": "range, x-evil",
			},
		})
		expect(res.status).toBe(204)
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(DASH)
		expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD, OPTIONS")
		expect(res.headers.get("Access-Control-Allow-Headers")).toBe("range")
	})

	it("adds CORS to errors too", async () => {
		const res = await call("/nope", { headers: { Origin: DASH } })
		expect(res.status).toBe(404)
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(DASH)
	})
})

describe("misc", () => {
	it("reports health", async () => {
		const res = await call("/health")
		expect(await res.json()).toEqual({ ok: true })
	})

	it("rejects writes", async () => {
		const res = await call("/0/0/0.mvt", { method: "POST" })
		expect(res.status).toBe(405)
		expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS")
	})
})
