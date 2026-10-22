import { EtagMismatch, PMTiles, ResolvedValueCache, type RangeResponse, type Source } from "pmtiles"

/** The archive object is missing from the bucket (not uploaded yet, or a wrong ARCHIVE_KEY). */
export class ArchiveMissing extends Error {
	constructor(key: string) {
		super(`PMTiles archive ${key} is not in the bucket`)
	}
}

/**
 * Reads byte ranges of a PMTiles archive from R2. Every read after the header is conditional on
 * the header's ETag, so replacing the archive mid-flight raises EtagMismatch; PMTiles then drops
 * its cached header and directories and retries once against the new archive.
 */
export class R2Source implements Source {
	constructor(
		private readonly bucket: R2Bucket,
		private readonly key: string,
	) {}

	getKey(): string {
		return this.key
	}

	async getBytes(
		offset: number,
		length: number,
		_signal?: AbortSignal,
		etag?: string,
	): Promise<RangeResponse> {
		const object = await this.bucket.get(this.key, {
			range: { offset, length },
			onlyIf: etag ? { etagMatches: etag } : undefined,
		})
		if (!object) throw new ArchiveMissing(this.key)
		if (!("body" in object)) throw new EtagMismatch(`ETag of ${this.key} changed`)
		return { data: await object.arrayBuffer(), etag: object.etag }
	}
}

// Headers and directories of the archive, kept per isolate. Workers cannot share promises across
// requests, so this is the resolved-value cache rather than the default shared-promise one.
let directoryCache = new ResolvedValueCache(64)
const validatedAt = new Map<string, number>()

/**
 * Directory reads and tile reads are conditional on the cached header's ETag, so a replaced
 * archive is noticed on the next read. Requests answered from the cached header alone (zoom
 * bounds, TileJSON, an address with no tile) are not, so the header is re-read at most this often.
 */
export const HEADER_TTL_MS = 60_000

export function openArchive(bucket: R2Bucket, key: string): PMTiles {
	const source = new R2Source(bucket, key)
	const now = Date.now()
	if (now - (validatedAt.get(key) ?? 0) > HEADER_TTL_MS) {
		void directoryCache.invalidate(source)
		validatedAt.set(key, now)
	}
	return new PMTiles(source, directoryCache)
}

/** Drops every cached header and directory (tests). */
export function forgetArchives(): void {
	directoryCache = new ResolvedValueCache(64)
	validatedAt.clear()
}
