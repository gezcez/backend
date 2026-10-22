// public-analytics.dto.ts
// Public analytics (plan 6.9 and 7.4): aggregate only, no vehicle or trip identifiers.

import { createZodDto } from "nestjs-zod"
import { z } from "zod"

const I18n = z.object({ tr: z.string(), en: z.string() })

export class PublicQualityQueryDto extends createZodDto(
	z.object({
		city: z
			.string()
			.regex(/^[a-z0-9-]{1,64}$/)
			.optional()
			.describe("City slug (default: every public city)"),
		days: z.coerce.number().int().min(1).max(30).default(7).describe("Closed days back"),
	}),
) {}

export class PublicFleetQueryDto extends createZodDto(
	z.object({
		city: z
			.string()
			.regex(/^[a-z0-9-]{1,64}$/)
			.optional()
			.describe("City slug (default: every public city)"),
	}),
) {}

const QualityDaySchema = z.object({
	date: z.string(),
	score: z.number().nullable(),
	success_rate: z.number().nullable(),
	lag_p95_s: z.number().nullable(),
	coverage: z.number().nullable(),
	gap_minutes: z.number(),
})

export const PublicQualitySchema = z.object({
	from: z.string(),
	to: z.string(),
	cities: z.array(
		z.object({
			slug: z.string(),
			name: I18n,
			/** Mean of the networks' daily scores (0-100), null without data. */
			score: z.number().nullable(),
			networks: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					score: z.number().nullable(),
					days: z.array(QualityDaySchema),
				}),
			),
		}),
	),
})
export class PublicQualityDto extends createZodDto(PublicQualitySchema) {}

const FleetDaySchema = z.object({
	date: z.string(),
	/** Distinct vehicles seen during the local day. */
	vehicles: z.number().int(),
	/** Most vehicles in service at once (5 min slots). */
	peak_vehicles: z.number().int(),
	vehicle_hours: z.number(),
	/** Distinct vehicles per local hour, [hour 0-23, vehicles]. */
	hours: z.array(z.tuple([z.number().int(), z.number().int()])),
})

export const PublicFleetSchema = z.object({
	generated_at: z.string(),
	networks: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			city: z.string(),
			timezone: z.string(),
			today: FleetDaySchema,
			yesterday: FleetDaySchema,
		}),
	),
})
export class PublicFleetDto extends createZodDto(PublicFleetSchema) {}
