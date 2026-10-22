// gtfs.csv.ts
// Streaming RFC 4180 CSV reader for GTFS text files: quoted fields with commas, line breaks and
// doubled quotes, CRLF/LF/CR line ends, a UTF-8 byte order mark, blank lines and padded values.
// Rows come out as string arrays; `GtfsTable` maps them to columns by header name.

const QUOTE = 34
const COMMA = 44
const LF = 10
const CR = 13

/** Incremental parser: feed text, collect complete rows. */
export class CsvParser {
	private row: string[] = []
	private field = ""
	private inQuotes = false
	/** A quote closed a quoted field at the very end of the previous chunk (may be `""`). */
	private quotePending = false
	/** The last chunk ended with CR; a leading LF in the next chunk belongs to it. */
	private crPending = false
	private fieldQuoted = false

	push(text: string, out: string[][]): void {
		let i = 0
		const n = text.length
		if (this.crPending) {
			this.crPending = false
			if (n && text.charCodeAt(0) === LF) i = 1
		}
		if (this.quotePending && i < n) {
			this.quotePending = false
			if (text.charCodeAt(i) === QUOTE) {
				this.field += '"'
				this.inQuotes = true
				i++
			}
		}
		let start = i
		while (i < n) {
			if (this.inQuotes) {
				const q = text.indexOf('"', i)
				if (q === -1) {
					this.field += text.slice(i)
					i = n
					start = n
					break
				}
				this.field += text.slice(i, q)
				if (q + 1 >= n) {
					// Decide on the next chunk whether this is "" or the closing quote.
					this.inQuotes = false
					this.quotePending = true
					i = n
					start = n
					break
				}
				if (text.charCodeAt(q + 1) === QUOTE) {
					this.field += '"'
					i = q + 2
				} else {
					this.inQuotes = false
					i = q + 1
				}
				start = i
				continue
			}
			const c = text.charCodeAt(i)
			if (c === COMMA) {
				this.endField(text.slice(start, i))
				i++
				start = i
			} else if (c === LF || c === CR) {
				this.endField(text.slice(start, i))
				this.endRow(out)
				if (c === CR) {
					if (i + 1 >= n) this.crPending = true
					else if (text.charCodeAt(i + 1) === LF) i++
				}
				i++
				start = i
			} else if (
				c === QUOTE &&
				!this.fieldQuoted &&
				this.field.trim() === "" &&
				text.slice(start, i).trim() === ""
			) {
				this.field = ""
				this.inQuotes = true
				this.fieldQuoted = true
				i++
				start = i
			} else {
				i++
			}
		}
		if (start < n) this.field += text.slice(start, n)
	}

	/** Flushes the last row when the input does not end with a line break. */
	end(out: string[][]): void {
		this.quotePending = false
		this.inQuotes = false
		if (this.field !== "" || this.row.length) {
			this.endField("")
			this.endRow(out)
		}
	}

	private endField(tail: string): void {
		// Anything after a closing quote is padding; unquoted values are trimmed.
		this.row.push(this.fieldQuoted ? this.field + tail.trim() : (this.field + tail).trim())
		this.field = ""
		this.fieldQuoted = false
	}

	private endRow(out: string[][]): void {
		const row = this.row
		this.row = []
		// Blank lines (a single empty field) are skipped.
		if (row.length === 1 && row[0] === "") return
		out.push(row)
	}
}

/** Parses a whole CSV string (tests and small files). */
export function parseCsv(text: string): string[][] {
	const out: string[][] = []
	const parser = new CsvParser()
	parser.push(text, out)
	parser.end(out)
	return out
}

/** Decodes a byte stream and yields batches of parsed rows. */
export async function* csvRows(
	bytes: AsyncIterable<Uint8Array>,
	encoding = "utf-8",
): AsyncGenerator<string[][]> {
	// TextDecoder drops a leading UTF-8 BOM by default; GtfsTable strips a stray one as well.
	const decoder = new TextDecoder(encoding as ConstructorParameters<typeof TextDecoder>[0])
	const parser = new CsvParser()
	for await (const chunk of bytes) {
		const out: string[][] = []
		parser.push(decoder.decode(chunk, { stream: true }), out)
		if (out.length) yield out
	}
	const out: string[][] = []
	parser.push(decoder.decode(), out)
	parser.end(out)
	if (out.length) yield out
}

/** Column lookup for one GTFS file, from its header row. */
export class GtfsTable {
	private readonly index = new Map<string, number>()

	constructor(header: string[]) {
		header.forEach((name, i) => {
			const key = name.replace(/^﻿/, "").trim().toLowerCase()
			if (!this.index.has(key)) this.index.set(key, i)
		})
	}

	has(column: string): boolean {
		return this.index.has(column)
	}

	/** A getter for one column; missing columns and empty cells read as "". */
	column(name: string): (row: string[]) => string {
		const i = this.index.get(name)
		if (i === undefined) return () => ""
		return (row) => row[i] ?? ""
	}
}
