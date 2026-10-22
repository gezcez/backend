// archive.dto.ts
// Dashboard archive DTOs (plan 7.2): manifest with export and upload status, re-run results.

import { createZodDto } from "nestjs-zod"
import { z } from "zod"

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
const iso = z.string().nullable()

export class ArchiveQueryDto extends createZodDto(
	z.object({
		binding_id: z.coerce.number().int().positive().optional(),
		from: date.optional(),
		to: date.optional(),
		limit: z.coerce.number().int().min(1).max(1000).default(150),
	}),
) {}

export const ManifestEntrySchema = z.object({
	binding_id: z.number().int(),
	date: z.string(),
	dataset: z.enum(["positions", "trip_runs", "polls"]),
	rows: z.number().int(),
	bytes: z.number().int(),
	sha256: z.string(),
	path: z.string(),
	exported_at: z.string(),
	verified_at: iso,
	uploaded_at: iso,
	state: z.enum(["failed", "verified", "uploaded"]),
})

export const ArchiveStatusSchema = z.object({
	uploader: z.enum(["none", "local", "s3"]),
	can_write: z.boolean(),
	schedules: z.array(
		z.object({
			key: z.enum(["archive.export", "analytics.aggregates"]),
			next_run_at: iso,
		}),
	),
	last_run: z
		.object({
			started_at: z.string(),
			finished_at: z.string(),
			days: z.number().int(),
			failures: z.number().int(),
			uploads_retried: z.number().int(),
			pruned: z.number().int(),
		})
		.nullable(),
	entries: z.array(ManifestEntrySchema),
})
export class ArchiveStatusDto extends createZodDto(ArchiveStatusSchema) {}

export const DayExportSchema = z.object({
	binding_id: z.number().int(),
	date: z.string(),
	skipped: z.boolean(),
	datasets: z.array(
		z.object({
			dataset: z.enum(["positions", "trip_runs", "polls"]),
			rows: z.number().int(),
			bytes: z.number().int(),
			sha256: z.string().nullable(),
			verified: z.boolean(),
			uploaded: z.boolean(),
			error: z.string().nullable(),
		}),
	),
})
export class DayExportDto extends createZodDto(DayExportSchema) {}
