// app-config.dto.ts

import { createZodDto } from "nestjs-zod"
import { z } from "zod"

const I18nText = z.object({ tr: z.string(), en: z.string() })

export const AnnouncementSchema = z.object({
	id: z.string().min(1).max(64),
	level: z.enum(["info", "warning"]),
	title: I18nText,
	body: I18nText,
	url: z.url().nullable(),
})

export const AppConfigQuerySchema = z.object({
	platform: z.enum(["ios", "android"]).optional(),
	version: z
		.string()
		.max(32)
		.regex(/^\d+(\.\d+){0,2}([-+].*)?$/)
		.optional(),
})
export class AppConfigQueryDto extends createZodDto(AppConfigQuerySchema) {}

export const AppConfigSchema = z.object({
	min_supported_version: z.string().describe("Older apps must update (force update)"),
	soft_update_version: z.string().nullable().describe("Older apps are nudged to update"),
	update: z
		.enum(["none", "soft", "force"])
		.describe("The caller's update state, from `version` (none without it)"),
	flags: z.record(z.string(), z.boolean()),
	kill_switches: z
		.record(z.string(), z.boolean())
		.describe("Feature availability: false turns a feature off (cards, live_map, ...)"),
	announcement: AnnouncementSchema.nullable(),
	tiles_style_url: z.object({ light: z.url(), dark: z.url() }),
	ws_url: z.string(),
})
export class AppConfigDto extends createZodDto(AppConfigSchema) {}
