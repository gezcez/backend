// archive.uploader.ts
// Upload seam for Parquet partitions (plan 8.8). The key is the partition path relative to
// data/archive, so R2 mirrors the local layout. Implementations:
// - none: files stay local; nothing is ever marked uploaded (retention keeps hot data);
// - local: copies into ARCHIVE_MIRROR_DIR (a mounted backup volume, or tests);
// - s3: Cloudflare R2 through the S3 API (`@aws-sdk/client-s3`), HEAD-checked by size.

import fs from "node:fs"
import path from "node:path"
import type { AnalyticsConfig } from "@common/config"

export interface ArchiveUploader {
	readonly kind: "none" | "local" | "s3"
	/** Uploads `file` under `key`. */
	put(key: string, file: string): Promise<void>
	/** Size in bytes of the uploaded object, or null when it is not there. */
	head(key: string): Promise<number | null>
}

export const ARCHIVE_UPLOADER = Symbol("ARCHIVE_UPLOADER")

export class NoopUploader implements ArchiveUploader {
	readonly kind = "none" as const
	async put(): Promise<void> {}
	async head(): Promise<number | null> {
		return null
	}
}

export class LocalMirrorUploader implements ArchiveUploader {
	readonly kind = "local" as const
	constructor(private readonly dir: string) {}

	private target(key: string): string {
		const target = path.resolve(this.dir, key)
		if (!target.startsWith(path.resolve(this.dir) + path.sep))
			throw new Error(`Key escapes the mirror: ${key}`)
		return target
	}

	async put(key: string, file: string): Promise<void> {
		const target = this.target(key)
		fs.mkdirSync(path.dirname(target), { recursive: true })
		fs.copyFileSync(file, `${target}.tmp`)
		fs.renameSync(`${target}.tmp`, target)
	}

	async head(key: string): Promise<number | null> {
		try {
			return fs.statSync(this.target(key)).size
		} catch {
			return null
		}
	}
}

type S3Config = Extract<AnalyticsConfig["upload"], { kind: "s3" }>

export class S3Uploader implements ArchiveUploader {
	readonly kind = "s3" as const
	private client: Promise<import("@aws-sdk/client-s3").S3Client> | undefined

	constructor(private readonly config: S3Config) {}

	private s3() {
		this.client ??= import("@aws-sdk/client-s3").then(
			({ S3Client }) =>
				new S3Client({
					region: "auto",
					endpoint: this.config.endpoint,
					credentials: {
						accessKeyId: this.config.accessKeyId,
						secretAccessKey: this.config.secretAccessKey,
					},
				}),
		)
		return this.client
	}

	private key(key: string): string {
		return `${this.config.prefix}${key}`
	}

	async put(key: string, file: string): Promise<void> {
		const { PutObjectCommand } = await import("@aws-sdk/client-s3")
		const client = await this.s3()
		const size = fs.statSync(file).size
		await client.send(
			new PutObjectCommand({
				Bucket: this.config.bucket,
				Key: this.key(key),
				Body: fs.createReadStream(file),
				ContentLength: size,
				ContentType: "application/vnd.apache.parquet",
			}),
		)
	}

	async head(key: string): Promise<number | null> {
		const { HeadObjectCommand } = await import("@aws-sdk/client-s3")
		const client = await this.s3()
		try {
			const result = await client.send(
				new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.key(key) }),
			)
			return result.ContentLength ?? null
		} catch (error) {
			if ((error as { name?: string }).name === "NotFound") return null
			throw error
		}
	}
}

export function createUploader(config: AnalyticsConfig): ArchiveUploader {
	switch (config.upload.kind) {
		case "s3":
			return new S3Uploader(config.upload)
		case "local":
			return new LocalMirrorUploader(config.upload.dir)
		default:
			return new NoopUploader()
	}
}
