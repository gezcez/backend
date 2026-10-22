// cities.dto.ts

import { createZodDto } from "nestjs-zod"
import { z } from "zod"
import {
	BBoxSchema,
	CapabilitiesSchema,
	I18nTextSchema,
	LonLatSchema,
	ModeSchema,
	NetworkSummarySchema,
} from "@common/models/transit.models"

export const CityBaseSchema = z.object({
	id: z.number().int(),
	slug: z.string(),
	name: I18nTextSchema,
	country_code: z.string(),
	timezone: z.string(),
	centre: LonLatSchema.nullable(),
	bbox: BBoxSchema.nullable(),
})

export const CitySchema = CityBaseSchema.extend({ networks: z.array(NetworkSummarySchema) })
export class CityDto extends createZodDto(CitySchema) {}

export const PulledDataSchema = z.object({
	key: z.string(),
	is_collected: z.boolean(),
	can_optout: z.boolean(),
	details: z.string(),
})

export const NetworkManifestSchema = NetworkSummarySchema.extend({
	city_id: z.number().int(),
	capabilities: CapabilitiesSchema,
	pack_version: z.string().nullable().describe("Changes whenever the static data changes"),
	attribution: z.array(
		z.object({ provider: z.string(), name: z.string(), url: z.string().nullable() }),
	),
	privacy: z.array(z.object({ provider: z.string(), pulled_data: z.array(PulledDataSchema) })),
	freshness: z.object({
		static_synced_at: z.string().nullable(),
		realtime_feed_at: z.string().nullable(),
		static_may_be_outdated: z.boolean(),
	}),
})
export class NetworkManifestDto extends createZodDto(NetworkManifestSchema) {}

export const CityManifestSchema = z.object({
	city: CityBaseSchema,
	networks: z.array(NetworkManifestSchema),
	route_types: z.array(z.object({ mode: ModeSchema, label: I18nTextSchema })),
	map: z.object({
		centre: LonLatSchema.nullable(),
		bbox: BBoxSchema.nullable(),
		initial_zoom: z.number(),
	}),
	generated_at: z.string(),
})
export class CityManifestDto extends createZodDto(CityManifestSchema) {}

export const ProviderPublicSchema = z.object({
	key: z.string(),
	name: z.string(),
	url: z.string().nullable(),
	image_url: z.string().nullable(),
	enabled: z.boolean(),
	pulled_data: z.array(PulledDataSchema),
	legal_note: z.string().nullable(),
})
export class ProviderPublicDto extends createZodDto(ProviderPublicSchema) {}
