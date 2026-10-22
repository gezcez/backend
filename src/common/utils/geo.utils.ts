// geo.utils.ts
// Distances, bboxes, micro-degree integers, the nearby grid and polyline encoding.

export type BBox = [west: number, south: number, east: number, north: number]

const EARTH_RADIUS_M = 6_371_008.8

export function toE6(value: number): number {
	return Math.round(value * 1e6)
}

export function fromE6(value: number): number {
	return value / 1e6
}

/** Great-circle distance in metres. */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const rad = Math.PI / 180
	const dLat = (lat2 - lat1) * rad
	const dLon = (lon2 - lon1) * rad
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

export function inBBox(lat: number, lon: number, bbox: BBox): boolean {
	return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]
}

/** Grows a bbox by `metres` on every side. */
export function expandBBox(bbox: BBox, metres: number): BBox {
	const dLat = metres / 111_320
	const midLat = (bbox[1] + bbox[3]) / 2
	const dLon = metres / (111_320 * Math.max(0.1, Math.cos((midLat * Math.PI) / 180)))
	return [bbox[0] - dLon, bbox[1] - dLat, bbox[2] + dLon, bbox[3] + dLat]
}

/** Grid cell size for nearby-stop lookups (plan 5.2: 0.005 degree). */
export const CELL_DEG = 0.005
const CELL_COLS = Math.round(360 / CELL_DEG)

/** Packs the 0.005 degree cell containing a point into one integer. */
export function gridCell(lat: number, lon: number): number {
	const row = Math.floor((lat + 90) / CELL_DEG)
	const col = Math.floor((lon + 180) / CELL_DEG)
	return row * CELL_COLS + col
}

/** Every cell intersecting a circle of `radiusM` around a point. */
export function cellsAround(lat: number, lon: number, radiusM: number): number[] {
	const dLat = radiusM / 111_320
	const dLon = radiusM / (111_320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)))
	const rowMin = Math.floor((lat - dLat + 90) / CELL_DEG)
	const rowMax = Math.floor((lat + dLat + 90) / CELL_DEG)
	const colMin = Math.floor((lon - dLon + 180) / CELL_DEG)
	const colMax = Math.floor((lon + dLon + 180) / CELL_DEG)
	const cells: number[] = []
	for (let row = rowMin; row <= rowMax; row++)
		for (let col = colMin; col <= colMax; col++) cells.push(row * CELL_COLS + col)
	return cells
}

/** Web-mercator tile column/row of a point at zoom `z`. */
export function lonLatToTile(lon: number, lat: number, z: number): [number, number] {
	const n = 2 ** z
	const x = Math.floor(((lon + 180) / 360) * n)
	const latRad = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180
	const y = Math.floor(
		((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
	)
	return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))]
}

function tileToLonLat(x: number, y: number, z: number): [number, number] {
	const n = 2 ** z
	const lon = (x / n) * 360 - 180
	const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
	return [lon, lat]
}

/** Snaps a bbox outward to the tile grid at zoom `z` so equal views share one filter. */
export function snapBBoxToTiles(bbox: BBox, z = 12): BBox {
	const [x0, y1] = lonLatToTile(bbox[0], bbox[1], z)
	const [x1, y0] = lonLatToTile(bbox[2], bbox[3], z)
	const [west, north] = tileToLonLat(x0, y0, z)
	const [east, south] = tileToLonLat(x1 + 1, y1 + 1, z)
	const round = (v: number) => Math.round(v * 1e6) / 1e6
	return [round(west), round(south), round(east), round(north)]
}

/** Google encoded polyline of [lat, lon] points. Precision 6 by default (plan 6.11). */
export function encodePolyline(points: [number, number][], precision = 6): string {
	const factor = 10 ** precision
	let lastLat = 0
	let lastLon = 0
	let out = ""
	const encode = (value: number) => {
		let v = value < 0 ? ~(value << 1) : value << 1
		while (v >= 0x20) {
			out += String.fromCharCode((0x20 | (v & 0x1f)) + 63)
			v >>= 5
		}
		out += String.fromCharCode(v + 63)
	}
	for (const [lat, lon] of points) {
		const la = Math.round(lat * factor)
		const lo = Math.round(lon * factor)
		encode(la - lastLat)
		encode(lo - lastLon)
		lastLat = la
		lastLon = lo
	}
	return out
}

export function decodePolyline(encoded: string, precision = 6): [number, number][] {
	const factor = 10 ** precision
	const points: [number, number][] = []
	let index = 0
	let lat = 0
	let lon = 0
	const next = () => {
		let result = 0
		let shift = 0
		let byte: number
		do {
			byte = encoded.charCodeAt(index++) - 63
			result |= (byte & 0x1f) << shift
			shift += 5
		} while (byte >= 0x20)
		return result & 1 ? ~(result >> 1) : result >> 1
	}
	while (index < encoded.length) {
		lat += next()
		lon += next()
		points.push([lat / factor, lon / factor])
	}
	return points
}

/** Length of a [lat, lon] polyline in metres. */
export function polylineLengthM(points: [number, number][]): number {
	let total = 0
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1]!
		const b = points[i]!
		total += haversineM(a[0], a[1], b[0], b[1])
	}
	return total
}
