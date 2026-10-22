// gtfs.zip.ts
// A small ZIP reader for GTFS archives (no dependency): reads the central directory, supports
// stored and deflated entries and ZIP64 sizes, and streams each entry's bytes so a large
// stop_times.txt never has to sit uncompressed in memory.

import { createInflateRaw } from "node:zlib"

export class ZipError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ZipError"
	}
}

export interface ZipEntry {
	/** Full path inside the archive ("gtfs/stops.txt"). */
	name: string
	method: number
	compressedSize: number
	size: number
	crc32: number
	localHeaderOffset: number
}

const EOCD_SIG = 0x06054b50
const ZIP64_EOCD_SIG = 0x06064b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const MAX_U32 = 0xffffffff

const CRC_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		table[n] = c >>> 0
	}
	return table
})()

/** CRC-32 (IEEE) of `bytes`, continuing from `previous`. */
export function crc32(bytes: Uint8Array, previous = 0): number {
	let crc = previous ^ MAX_U32
	for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
	return (crc ^ MAX_U32) >>> 0
}

function u64(view: DataView, offset: number): number {
	return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 2 ** 32
}

export class ZipArchive {
	readonly entries: ZipEntry[]
	private readonly view: DataView

	constructor(private readonly bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		this.entries = this.readCentralDirectory()
	}

	private findEocd(): number {
		// The end record is at least 22 bytes and may be followed by a comment of up to 64 KiB.
		const min = Math.max(0, this.bytes.length - 22 - 0xffff)
		for (let i = this.bytes.length - 22; i >= min; i--) {
			if (this.view.getUint32(i, true) === EOCD_SIG) return i
		}
		throw new ZipError("not a zip archive (no end of central directory)")
	}

	private readCentralDirectory(): ZipEntry[] {
		const eocd = this.findEocd()
		let count = this.view.getUint16(eocd + 10, true)
		let offset = this.view.getUint32(eocd + 16, true)
		if (
			(count === 0xffff || offset === MAX_U32) &&
			eocd >= 20 &&
			this.view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIG
		) {
			const zip64 = u64(this.view, eocd - 20 + 8)
			if (this.view.getUint32(zip64, true) !== ZIP64_EOCD_SIG)
				throw new ZipError("broken zip64 end of central directory")
			count = u64(this.view, zip64 + 32)
			offset = u64(this.view, zip64 + 48)
		}
		const entries: ZipEntry[] = []
		const decoder = new TextDecoder()
		for (let i = 0; i < count; i++) {
			if (offset + 46 > this.bytes.length || this.view.getUint32(offset, true) !== CENTRAL_SIG)
				throw new ZipError("broken central directory")
			const method = this.view.getUint16(offset + 10, true)
			const crc = this.view.getUint32(offset + 16, true)
			let compressedSize = this.view.getUint32(offset + 20, true)
			let size = this.view.getUint32(offset + 24, true)
			const nameLength = this.view.getUint16(offset + 28, true)
			const extraLength = this.view.getUint16(offset + 30, true)
			const commentLength = this.view.getUint16(offset + 32, true)
			let localHeaderOffset = this.view.getUint32(offset + 42, true)
			const name = decoder.decode(this.bytes.subarray(offset + 46, offset + 46 + nameLength))
			// ZIP64 extended information extra field (0x0001): only the maxed-out fields appear.
			let extra = offset + 46 + nameLength
			const extraEnd = extra + extraLength
			while (extra + 4 <= extraEnd) {
				const id = this.view.getUint16(extra, true)
				const length = this.view.getUint16(extra + 2, true)
				if (id === 0x0001) {
					let p = extra + 4
					if (size === MAX_U32) {
						size = u64(this.view, p)
						p += 8
					}
					if (compressedSize === MAX_U32) {
						compressedSize = u64(this.view, p)
						p += 8
					}
					if (localHeaderOffset === MAX_U32) localHeaderOffset = u64(this.view, p)
				}
				extra += 4 + length
			}
			entries.push({ name, method, compressedSize, size, crc32: crc, localHeaderOffset })
			offset = extraEnd + commentLength
		}
		return entries
	}

	/** The entry whose base name is `fileName` (GTFS zips sometimes nest files in a folder). */
	find(fileName: string): ZipEntry | undefined {
		const lower = fileName.toLowerCase()
		const exact = this.entries.find((e) => e.name.toLowerCase() === lower)
		if (exact) return exact
		return this.entries.find(
			(e) => !e.name.endsWith("/") && e.name.toLowerCase().split("/").pop() === lower,
		)
	}

	private compressed(entry: ZipEntry): Uint8Array {
		const at = entry.localHeaderOffset
		if (this.view.getUint32(at, true) !== LOCAL_SIG)
			throw new ZipError(`broken local header for ${entry.name}`)
		const nameLength = this.view.getUint16(at + 26, true)
		const extraLength = this.view.getUint16(at + 28, true)
		const start = at + 30 + nameLength + extraLength
		if (start + entry.compressedSize > this.bytes.length)
			throw new ZipError(`truncated entry ${entry.name}`)
		return this.bytes.subarray(start, start + entry.compressedSize)
	}

	/** Streams the entry's uncompressed bytes and checks size and CRC at the end. */
	async *stream(entry: ZipEntry): AsyncGenerator<Uint8Array> {
		const data = this.compressed(entry)
		let crc = 0
		let total = 0
		if (entry.method === 0) {
			const chunk = 1 << 20
			for (let i = 0; i < data.length; i += chunk) {
				const part = data.subarray(i, i + chunk)
				crc = crc32(part, crc)
				total += part.length
				yield part
			}
		} else if (entry.method === 8) {
			const inflate = createInflateRaw()
			inflate.end(data)
			try {
				for await (const part of inflate as AsyncIterable<Buffer>) {
					const bytes = new Uint8Array(part.buffer, part.byteOffset, part.byteLength)
					crc = crc32(bytes, crc)
					total += bytes.length
					yield bytes
				}
			} catch (error) {
				throw new ZipError(`inflate failed for ${entry.name}: ${(error as Error).message}`)
			}
		} else {
			throw new ZipError(`unsupported compression method ${entry.method} for ${entry.name}`)
		}
		if (total !== entry.size) throw new ZipError(`size mismatch for ${entry.name}`)
		if (crc !== entry.crc32) throw new ZipError(`crc mismatch for ${entry.name}`)
	}
}
