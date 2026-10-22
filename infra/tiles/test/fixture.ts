/**
 * Writes small PMTiles v3 archives for the tests: one root directory, no leaf directories,
 * uncompressed directories and metadata. Tile payloads are arbitrary bytes, optionally gzipped
 * so the Worker's decompression path is exercised.
 */
import { zxyToTileId } from "pmtiles"

export type FixtureTile = { z: number; x: number; y: number; data: Uint8Array }

export type FixtureOptions = {
	tiles: FixtureTile[]
	minZoom?: number
	maxZoom?: number
	gzip?: boolean
	metadata?: Record<string, unknown>
}

const HEADER_BYTES = 127

function varint(out: number[], value: number): void {
	let v = value
	while (v >= 0x80) {
		out.push((v & 0x7f) | 0x80)
		v = Math.floor(v / 128)
	}
	out.push(v)
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"))
	return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function buildPmtiles(options: FixtureOptions): Promise<Uint8Array> {
	const zooms = options.tiles.map((t) => t.z)
	const minZoom = options.minZoom ?? Math.min(...zooms)
	const maxZoom = options.maxZoom ?? Math.max(...zooms)
	const sorted = [...options.tiles]
		.map((t) => ({ id: zxyToTileId(t.z, t.x, t.y), data: t.data }))
		.sort((a, b) => a.id - b.id)

	const blobs: Uint8Array[] = []
	const entries: { id: number; offset: number; length: number }[] = []
	let offset = 0
	for (const t of sorted) {
		const bytes = options.gzip ? await gzip(t.data) : t.data
		entries.push({ id: t.id, offset, length: bytes.length })
		blobs.push(bytes)
		offset += bytes.length
	}

	const dir: number[] = []
	varint(dir, entries.length)
	let last = 0
	for (const e of entries) {
		varint(dir, e.id - last)
		last = e.id
	}
	for (const _ of entries) varint(dir, 1)
	for (const e of entries) varint(dir, e.length)
	entries.forEach((e, i) => {
		const prev = entries[i - 1]
		varint(dir, prev && e.offset === prev.offset + prev.length ? 0 : e.offset + 1)
	})
	const root = new Uint8Array(dir)
	const metadata = new TextEncoder().encode(
		JSON.stringify(
			options.metadata ?? {
				name: "fixture",
				vector_layers: [{ id: "earth", fields: {} }],
			},
		),
	)

	const rootOffset = HEADER_BYTES
	const metadataOffset = rootOffset + root.length
	const tileDataOffset = metadataOffset + metadata.length
	const total = tileDataOffset + offset

	const out = new Uint8Array(total)
	const view = new DataView(out.buffer)
	out.set(new TextEncoder().encode("PMTiles"), 0)
	view.setUint8(7, 3)
	const u64 = (at: number, value: number) => {
		view.setUint32(at, value % 2 ** 32, true)
		view.setUint32(at + 4, Math.floor(value / 2 ** 32), true)
	}
	u64(8, rootOffset)
	u64(16, root.length)
	u64(24, metadataOffset)
	u64(32, metadata.length)
	u64(40, tileDataOffset) // no leaf directories
	u64(48, 0)
	u64(56, tileDataOffset)
	u64(64, offset)
	u64(72, entries.length)
	u64(80, entries.length)
	u64(88, entries.length)
	view.setUint8(96, 1) // clustered
	view.setUint8(97, 1) // internal compression: none
	view.setUint8(98, options.gzip ? 2 : 1) // tile compression
	view.setUint8(99, 1) // tile type: mvt
	view.setUint8(100, minZoom)
	view.setUint8(101, maxZoom)
	// Turkey, roughly
	view.setInt32(102, 25.6e7, true)
	view.setInt32(106, 35.8e7, true)
	view.setInt32(110, 44.9e7, true)
	view.setInt32(114, 42.2e7, true)
	view.setUint8(118, Math.min(maxZoom, 6))
	view.setInt32(119, 32.85e7, true)
	view.setInt32(123, 39.93e7, true)

	out.set(root, rootOffset)
	out.set(metadata, metadataOffset)
	let at = tileDataOffset
	for (const b of blobs) {
		out.set(b, at)
		at += b.length
	}
	return out
}

export const bytes = (text: string) => new TextEncoder().encode(text)
