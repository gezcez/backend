// system.dto.ts

import { zodDto } from "@common/response"
import { z } from "zod"

export const HealthSchema = z.object({ status: z.literal("ok") })
export class HealthDto extends zodDto(HealthSchema) {}

export const ReadySchema = z.object({
	ready: z.boolean(),
	checks: z.array(z.object({ name: z.string(), ok: z.boolean() })),
})
export class ReadyDto extends zodDto(ReadySchema) {}

export const VersionSchema = z.object({
	version: z.string(),
	git_sha: z.string(),
	build_time: z.string().nullable(),
	mode: z.enum(["api", "tracker", "all"]),
	env: z.string(),
	uptime_s: z.number().int(),
})
export class VersionDto extends zodDto(VersionSchema) {}
