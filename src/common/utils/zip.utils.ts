// zip.utils.ts
// A small ZIP writer (and a reader for tests and verification) for the account data export
// (plan 6.1.7): a handful of JSON files and a README, deflated, UTF-8 names. No dependency.

import { deflateRawSync, inflateRawSync } from "node:zlib"

export interface ZipEntry {
	/** Path inside the archive, forward slashes, no leading slash. */
	name: string
	data: Uint8Array | string
	/** Modification time stored in the entry (DOS precision, 2 s). Defaults to now. */
	modified?: Date
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		table[n] = c >>> 0
	}
	return table
})()

export function crc32(data: Uint8Array): number {
	let crc = 0xffffffff
	for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
	return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date): { time: number; date: number } {
	const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107)
	return {
		time:
			(date.getUTCHours() << 11) |
			(date.getUTCMinutes() << 5) |
			Math.floor(date.getUTCSeconds() / 2),
		date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
	}
}

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL = 0x06054b50
/** Bit 11: names are UTF-8. */
const FLAG_UTF8 = 0x0800
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** Builds a complete archive in memory (exports are small: kilobytes to a few megabytes). */
export function createZip(entries: ZipEntry[]): Buffer {
	const encoder = new TextEncoder()
	const locals: Buffer[] = []
	const centrals: Buffer[] = []
	let offset = 0
	const seen = new Set<string>()
	for (const entry of entries) {
		if (!entry.name || entry.name.startsWith("/") || entry.name.includes(".."))
			throw new Error(`Invalid zip entry name: ${entry.name}`)
		if (seen.has(entry.name)) throw new Error(`Duplicate zip entry: ${entry.name}`)
		seen.add(entry.name)
		const name = Buffer.from(encoder.encode(entry.name))
		const raw = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data
		const deflated = deflateRawSync(raw)
		const useDeflate = deflated.length < raw.length
		const body = useDeflate ? deflated : Buffer.from(raw)
		const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE
		const crc = crc32(raw)
		const { time, date } = dosDateTime(entry.modified ?? new Date())

		const local = Buffer.alloc(30)
		local.writeUInt32LE(LOCAL_HEADER, 0)
		local.writeUInt16LE(20, 4)
		local.writeUInt16LE(FLAG_UTF8, 6)
		local.writeUInt16LE(method, 8)
		local.writeUInt16LE(time, 10)
		local.writeUInt16LE(date, 12)
		local.writeUInt32LE(crc, 14)
		local.writeUInt32LE(body.length, 18)
		local.writeUInt32LE(raw.length, 22)
		local.writeUInt16LE(name.length, 26)
		local.writeUInt16LE(0, 28)
		locals.push(local, name, body)

		const central = Buffer.alloc(46)
		central.writeUInt32LE(CENTRAL_HEADER, 0)
		central.writeUInt16LE(20, 4)
		central.writeUInt16LE(20, 6)
		central.writeUInt16LE(FLAG_UTF8, 8)
		central.writeUInt16LE(method, 10)
		central.writeUInt16LE(time, 12)
		central.writeUInt16LE(date, 14)
		central.writeUInt32LE(crc, 16)
		central.writeUInt32LE(body.length, 20)
		central.writeUInt32LE(raw.length, 24)
		central.writeUInt16LE(name.length, 28)
		// Extra length, comment length, disk number, internal attributes: 0.
		central.writeUInt32LE(0, 38)
		central.writeUInt32LE(offset, 42)
		centrals.push(central, name)

		offset += local.length + name.length + body.length
	}
	const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(END_OF_CENTRAL, 0)
	end.writeUInt16LE(entries.length, 8)
	end.writeUInt16LE(entries.length, 10)
	end.writeUInt32LE(centralSize, 12)
	end.writeUInt32LE(offset, 16)
	return Buffer.concat([...locals, ...centrals, end])
}

export interface ReadZipEntry {
	name: string
	data: Buffer
	modified: Date
}

/** Reads an archive written by createZip (stored or deflated, no ZIP64). Verifies every CRC. */
export function readZip(archive: Uint8Array): ReadZipEntry[] {
	const buf = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
	let endAt = -1
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
		if (buf.readUInt32LE(i) === END_OF_CENTRAL) {
			endAt = i
			break
		}
	}
	if (endAt < 0) throw new Error("Not a zip archive")
	const count = buf.readUInt16LE(endAt + 10)
	let at = buf.readUInt32LE(endAt + 16)
	const entries: ReadZipEntry[] = []
	for (let i = 0; i < count; i++) {
		if (buf.readUInt32LE(at) !== CENTRAL_HEADER) throw new Error("Bad central directory")
		const method = buf.readUInt16LE(at + 10)
		const time = buf.readUInt16LE(at + 12)
		const date = buf.readUInt16LE(at + 14)
		const crc = buf.readUInt32LE(at + 16)
		const compressed = buf.readUInt32LE(at + 20)
		const nameLength = buf.readUInt16LE(at + 28)
		const extraLength = buf.readUInt16LE(at + 30)
		const commentLength = buf.readUInt16LE(at + 32)
		const localAt = buf.readUInt32LE(at + 42)
		const name = buf.toString("utf8", at + 46, at + 46 + nameLength)
		if (buf.readUInt32LE(localAt) !== LOCAL_HEADER) throw new Error("Bad local header")
		const dataAt =
			localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28)
		const body = buf.subarray(dataAt, dataAt + compressed)
		const data =
			method === METHOD_DEFLATE
				? inflateRawSync(body)
				: method === METHOD_STORE
					? Buffer.from(body)
					: (() => {
							throw new Error(`Unsupported method ${method}`)
						})()
		if (crc32(data) !== crc) throw new Error(`CRC mismatch in ${name}`)
		entries.push({
			name,
			data,
			modified: new Date(
				Date.UTC(
					(date >> 9) + 1980,
					((date >> 5) & 0xf) - 1,
					date & 0x1f,
					time >> 11,
					(time >> 5) & 0x3f,
					(time & 0x1f) * 2,
				),
			),
		})
		at += 46 + nameLength + extraLength + commentLength
	}
	return entries
}
