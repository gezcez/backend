// system.dto.ts

import { createZodDto } from "nestjs-zod"
import { z } from "zod"

export const HealthSchema = z.object({ status: z.literal("ok") })
export class HealthDto extends createZodDto(HealthSchema) {}

export const ReadySchema = z.object({
	ready: z.boolean(),
	checks: z.array(z.object({ name: z.string(), ok: z.boolean() })),
})
export class ReadyDto extends createZodDto(ReadySchema) {}

export const VersionSchema = z.object({
	version: z.string(),
	git_sha: z.string(),
	build_time: z.string().nullable(),
	mode: z.enum(["api", "tracker", "all"]),
	env: z.string(),
	uptime_s: z.number().int(),
})
export class VersionDto extends createZodDto(VersionSchema) {}
