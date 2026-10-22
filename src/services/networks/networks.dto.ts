// networks.dto.ts
// Dashboard read shapes for the catalog. Upstream credentials never appear here: bindings carry
// only their non-secret config and which secret names are set.

import { createZodDto } from "nestjs-zod"
import { z } from "zod"
import {
	BBoxSchema,
	CapabilitiesSchema,
	I18nTextSchema,
	NetworkStatusSchema,
} from "@common/models/transit.models"

export const DashCitySchema = z.object({
	id: z.number().int(),
	slug: z.string(),
	name: I18nTextSchema,
	country_code: z.string(),
	timezone: z.string(),
	center_lat: z.number().nullable(),
	center_lon: z.number().nullable(),
	bbox: BBoxSchema.nullable(),
	status: z.enum(["draft", "public", "hidden"]),
	sort: z.number().int(),
})
export class DashCityDto extends createZodDto(DashCitySchema) {}

export const BindingStateSchema = z.enum(["ok", "degraded", "down", "paused", "killed", "unknown"])

export const DashBindingSchema = z.object({
	id: z.number().int(),
	network_id: z.number().int(),
	provider_key: z.string(),
	external_ref: z.string(),
	config: z.record(z.string(), z.unknown()),
	capabilities: CapabilitiesSchema,
	poll_interval_s: z.number().int(),
	idle_poll_interval_s: z.number().int(),
	status: z.enum(["active", "paused", "disabled"]),
	disabled_reason: z.string().nullable(),
	state: BindingStateSchema,
	state_message: z.string().nullable(),
	last_feed_at: z.string().nullable(),
	replayed: z.boolean().describe("Served by the fake provider (PROVIDER_REPLAY)"),
	created_at: z.string(),
	updated_at: z.string().nullable(),
})
export class DashBindingDto extends createZodDto(DashBindingSchema) {}

export const DashNetworkSchema = z.object({
	id: z.number().int(),
	city_id: z.number().int(),
	slug: z.string(),
	name: z.string(),
	operator_name: z.string().nullable(),
	colour: z.string().nullable(),
	status: z.enum(["draft", "public", "hidden"]),
	network_status: NetworkStatusSchema,
	network_status_message: z.string().nullable(),
	bindings: z.array(DashBindingSchema),
	created_at: z.string(),
	updated_at: z.string().nullable(),
})
export class DashNetworkDto extends createZodDto(DashNetworkSchema) {}

export const DashProviderSchema = z.object({
	key: z.string(),
	name: z.string(),
	url: z.string().nullable(),
	image_url: z.string().nullable(),
	enabled: z.boolean().describe("Dashboard kill switch (providers.enabled)"),
	env_enabled: z.boolean().describe("PROVIDER_<KEY>_ENABLED hard kill"),
	disabled_reason: z.string().nullable(),
	adapter: z.boolean().describe("An adapter for this key exists in this build"),
	replayed: z.boolean(),
	capabilities: CapabilitiesSchema.nullable(),
	pulled_data: z.array(
		z.object({
			key: z.string(),
			is_collected: z.boolean(),
			can_optout: z.boolean(),
			details: z.string(),
		}),
	),
	legal_note: z.string().nullable(),
	binding_count: z.number().int(),
})
export class DashProviderDto extends createZodDto(DashProviderSchema) {}

export const DashProviderDetailSchema = DashProviderSchema.extend({
	config_schema: z.record(z.string(), z.unknown()).nullable(),
	rate_hint: z.object({ host: z.string(), requests_per_second: z.number() }).nullable(),
	credentials: z.array(
		z.object({
			realm: z.string(),
			state: z.enum(["ok", "missing", "refreshing", "auth_failed", "unknown"]),
			expires_at: z.string().nullable(),
			refreshed_at: z.string().nullable(),
			failures: z.number().int(),
			secrets_set: z.record(z.string(), z.boolean()),
		}),
	),
})
export class DashProviderDetailDto extends createZodDto(DashProviderDetailSchema) {}

export const ProviderKillSchema = z.object({
	enabled: z.boolean(),
	reason: z.string().trim().min(3).max(500),
})
export class ProviderKillDto extends createZodDto(ProviderKillSchema) {}
