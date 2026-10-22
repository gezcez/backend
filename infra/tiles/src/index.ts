/**
 * tiles.gezcez.com
 *
 *   GET /{z}/{x}/{y}.mvt              vector tile from the PMTiles archive (empty body when none)
 *   GET /tiles.json                   TileJSON 3.0 for the archive
 *   GET /styles/gezcez-light.json     MapLibre styles (also gezcez-dark.json)
 *   GET /fonts/{fontstack}/{range}.pbf
 *   GET /sprites/v4/{name}[@2x].json|png
 *   GET /basemap.pmtiles              the raw archive, with Range support (pmtiles:// clients)
 *   GET /health
 *
 * Successful GETs are stored in the Cloudflare cache keyed by URL; CORS headers are added after
 * the cache so one cached copy serves every origin.
 */
import { ArchiveMissing, openArchive } from "./archive"
import { parseOrigins, preflight, withCors } from "./cors"
import {
	cacheControl,
	errorResponse,
	etagMatches,
	jsonResponse,
	parseRange,
	type ErrorCode,
} from "./http"
import { styleResponse } from "./styles"

const TILE_PATH = /^\/(\d{1,2})\/(\d+)\/(\d+)\.(mvt|pbf)$/
const FONT_PATH = /^\/fonts\/([^/]+)\/(\d+-\d+)\.pbf$/
const SPRITE_PATH = /^\/sprites\/([a-z0-9/_-]+(?:@2x)?)\.(json|png)$/
const STYLE_PATH = /^\/styles\/(gezcez-light|gezcez-dark)\.json$/

const ATTRIBUTION =
	'<a href="https://protomaps.com" target="_blank">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'

const METADATA_MAX_AGE = 3600
const ASSET_MAX_AGE = 604800

class HttpError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string,
	) {
		super(message)
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const origins = parseOrigins(env.ALLOWED_ORIGINS)
		if (request.method === "OPTIONS") return preflight(request, origins)
		if (request.method !== "GET" && request.method !== "HEAD") {
			const response = errorResponse("METHOD_NOT_ALLOWED", "Only GET and HEAD", {
				Allow: "GET, HEAD, OPTIONS",
			})
			return withCors(request, response, origins)
		}
		let response: Response
		try {
			response = await route(request, env, ctx)
		} catch (error) {
			response = toErrorResponse(error)
		}
		if (request.method === "HEAD") response = new Response(null, response)
		return withCors(request, response, origins)
	},
} satisfies ExportedHandler<Env>

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url)
	const path = decodeURIComponent(url.pathname)

	if (path === "/health") return jsonResponse({ ok: true }, "no-store")
	if (path === "/basemap.pmtiles") return rawArchive(request, env)

	const cache = await caches.open("gezcez-tiles")
	const key = new Request(`${url.origin}${url.pathname}`, { method: "GET" })
	const cached = await cache.match(key)
	const response = cached ?? (await build(path, url, env))
	if (!cached && response.status < 300) ctx.waitUntil(cache.put(key, response.clone()))
	return conditional(request, response)
}

async function build(path: string, url: URL, env: Env): Promise<Response> {
	let match: RegExpExecArray | null
	if (path === "/tiles.json") return tileJson(url, env)
	if ((match = TILE_PATH.exec(path)))
		return tile(env, Number(match[1]), Number(match[2]), Number(match[3]))
	if ((match = STYLE_PATH.exec(path)))
		return styleResponse(match[1] ?? "", url.origin, METADATA_MAX_AGE)
	if ((match = FONT_PATH.exec(path))) {
		return asset(env, `fonts/${match[1]}/${match[2]}.pbf`, "application/x-protobuf")
	}
	if ((match = SPRITE_PATH.exec(path))) {
		const type = match[2] === "png" ? "image/png" : "application/json; charset=utf-8"
		return asset(env, `sprites/${match[1]}.${match[2]}`, type)
	}
	throw new HttpError("NOT_FOUND", `No route for ${path}`)
}

async function tile(env: Env, z: number, x: number, y: number): Promise<Response> {
	const size = 2 ** z
	if (z > 24 || x >= size || y >= size) {
		throw new HttpError("BAD_REQUEST", `Tile ${z}/${x}/${y} is outside the tile grid`)
	}
	const archive = openArchive(env.BUCKET, env.ARCHIVE_KEY)
	const header = await archive.getHeader()
	if (z < header.minZoom || z > header.maxZoom) {
		throw new HttpError("NOT_FOUND", `Zoom ${z} is outside ${header.minZoom}-${header.maxZoom}`)
	}
	const data = await archive.getZxy(z, x, y)
	const headers = new Headers({
		"Content-Type": "application/vnd.mapbox-vector-tile",
		"Cache-Control": cacheControl(Number(env.TILE_MAX_AGE) || 86400),
	})
	if (header.etag) headers.set("ETag", `"${header.etag}"`)
	// No tile at this address (open sea, outside the extract): a zero-length body is a valid empty
	// vector tile. It is a 200 rather than a 204 so the Cache API stores it like any other tile.
	return new Response(data?.data ?? new ArrayBuffer(0), { headers })
}

async function tileJson(url: URL, env: Env): Promise<Response> {
	const archive = openArchive(env.BUCKET, env.ARCHIVE_KEY)
	// Reading the metadata first refreshes a cached header if the archive was replaced.
	await archive.getMetadata()
	const json = (await archive.getTileJson(url.origin)) as Record<string, unknown>
	json.attribution ??= ATTRIBUTION
	json.name ??= "gezcez basemap"
	return jsonResponse(json, cacheControl(METADATA_MAX_AGE))
}

async function asset(env: Env, key: string, contentType: string): Promise<Response> {
	const object = await env.BUCKET.get(`${env.ASSETS_PREFIX}${key}`)
	if (!object) throw new HttpError("NOT_FOUND", `No asset ${key}`)
	return new Response(object.body, {
		headers: {
			"Content-Type": contentType,
			"Cache-Control": cacheControl(ASSET_MAX_AGE),
			ETag: object.httpEtag,
		},
	})
}

/** The whole archive or one byte range of it, straight from R2. Not stored in the edge cache. */
async function rawArchive(request: Request, env: Env): Promise<Response> {
	const head = await env.BUCKET.head(env.ARCHIVE_KEY)
	if (!head) throw new ArchiveMissing(env.ARCHIVE_KEY)
	const headers = new Headers({
		"Content-Type": "application/vnd.pmtiles",
		"Cache-Control": cacheControl(METADATA_MAX_AGE),
		"Accept-Ranges": "bytes",
		ETag: head.httpEtag,
	})
	if (etagMatches(request.headers.get("If-None-Match"), head.httpEtag)) {
		return new Response(null, { status: 304, headers })
	}
	const ifMatch = request.headers.get("If-Match")
	if (ifMatch && !etagMatches(ifMatch, head.httpEtag)) {
		return errorResponse("PRECONDITION_FAILED", "The archive changed", { ETag: head.httpEtag })
	}
	const range = parseRange(request.headers.get("Range"), head.size)
	if (range === "unsatisfiable") {
		return errorResponse("RANGE_NOT_SATISFIABLE", "Unsupported or unsatisfiable range", {
			"Content-Range": `bytes */${head.size}`,
		})
	}
	if (request.method === "HEAD") {
		headers.set("Content-Length", String(range ? range.length : head.size))
		return new Response(null, { status: range ? 206 : 200, headers })
	}
	const object = await env.BUCKET.get(env.ARCHIVE_KEY, {
		range,
		onlyIf: { etagMatches: head.etag },
	})
	if (!object || !("body" in object)) {
		throw new HttpError("ARCHIVE_UNAVAILABLE", "The archive changed during the request, retry")
	}
	if (!range) return new Response(object.body, { headers })
	headers.set(
		"Content-Range",
		`bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
	)
	return new Response(object.body, { status: 206, headers })
}

/** Answers If-None-Match with 304 for cacheable responses that carry an ETag. */
function conditional(request: Request, response: Response): Response {
	const etag = response.headers.get("ETag")
	if (response.status !== 200 || !etag) return response
	if (!etagMatches(request.headers.get("If-None-Match"), etag)) return response
	const headers = new Headers(response.headers)
	headers.delete("Content-Length")
	return new Response(null, { status: 304, headers })
}

function toErrorResponse(error: unknown): Response {
	if (error instanceof HttpError) return errorResponse(error.code, error.message)
	if (error instanceof ArchiveMissing) return errorResponse("ARCHIVE_UNAVAILABLE", error.message)
	// eslint-disable-next-line no-console -- Workers Observability collects console output
	console.error("tiles: unhandled error", error)
	return errorResponse("INTERNAL", "Internal error")
}
