// telemetry.dto.ts
// Aggregate counters from the app (plan 5.1): no user, device, install or session id.

import { createZodDto } from "nestjs-zod"
import { z } from "zod"

export const TELEMETRY_MAX_KEYS = 50
export const TELEMETRY_MAX_COUNT = 10_000

export const TelemetryCountersSchema = z.object({
	day: z.iso.date().describe("The app's local day, YYYY-MM-DD; within two days of today"),
	platform: z.enum(["ios", "android"]),
	app_version: z
		.string()
		.min(1)
		.max(32)
		.regex(/^[0-9A-Za-z.+-]+$/),
	city: z.string().min(1).max(64).nullable().describe("City slug, or null before one is chosen"),
	counters: z
		.record(
			z.string().regex(/^[a-z0-9_.]{1,64}$/),
			z.number().int().min(0).max(TELEMETRY_MAX_COUNT),
		)
		.refine((c) => Object.keys(c).length <= TELEMETRY_MAX_KEYS, {
			message: `at most ${TELEMETRY_MAX_KEYS} counters`,
		}),
})
export class TelemetryCountersDto extends createZodDto(TelemetryCountersSchema) {}

export const TelemetryAcceptedSchema = z.object({ accepted: z.boolean() })
export class TelemetryAcceptedDto extends createZodDto(TelemetryAcceptedSchema) {}
