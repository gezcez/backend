// kentkart.filters.ts
// Binding config for Kentkart (non-secret, stored in provider_bindings.config and editable from
// the dashboard) and the drop rules for staff duty routes and test devices (plan 6.6).

import { z } from "zod"
import type { DropReason, RawVehicle } from "../transit-provider.interface"

export const KentkartBindingConfigSchema = z.object({
	api_url: z.url().default("https://service.kentkart.com/api"),
	fallback_url: z.url().default("https://service.kentkart.com/rl1/api"),
	/** route/list and city discovery. */
	static_url: z.url().default("https://service.kentkart.com/rl1/api"),
	/** pathInfo (stops, shapes, schedules). */
	web_url: z.url().default("https://service.kentkart.com/rl1/web"),
	auth_url: z.url().default("https://auth.kentkart.com/rl1"),
	/** Token realm; bindings that share it share one access token. */
	auth_realm: z.string().min(1).default("rl1"),
	auth_type: z
		.string()
		.regex(/^\d{1,2}$/)
		.default("4"),
	/** Labels (headsigns) of staff duty services, e.g. "GÖREVLİ6-GÖREVLİ6". */
	staff_label_pattern: z.string().default("G[ÖO]REVL[İI]"),
	/** Route code prefixes of staff duty services. */
	staff_route_prefixes: z.array(z.string()).default(["419"]),
	/** Plates (spaces ignored, case-insensitive) of bench and test devices. */
	test_plates: z.array(z.string()).default(["BLD4TEST"]),
	/** Static sync politeness. */
	static_concurrency: z.number().int().min(1).max(4).default(2),
	static_spacing_ms: z.number().int().min(0).max(10_000).default(300),
	/** Successes on the fallback URL before probing the primary again. */
	fallback_successes_before_probe: z.number().int().min(1).default(10),
	primary_probe_interval_s: z.number().int().min(30).default(600),
	request_timeout_ms: z.number().int().min(1000).max(60_000).default(10_000),
})

export type KentkartBindingConfig = z.infer<typeof KentkartBindingConfigSchema>

export function parseKentkartConfig(raw: Record<string, unknown>): KentkartBindingConfig {
	return KentkartBindingConfigSchema.parse(raw ?? {})
}

export function normalisePlate(plate: string): string {
	return plate.replace(/\s+/g, "").toUpperCase()
}

/** Returns why a vehicle must be dropped, or null to keep it. */
export function classifyKentkartVehicle(
	vehicle: RawVehicle,
	config: KentkartBindingConfig,
): DropReason | null {
	if (
		vehicle.routeExt &&
		config.staff_route_prefixes.some((p) => vehicle.routeExt!.startsWith(p))
	)
		return "staff"
	if (vehicle.label && new RegExp(config.staff_label_pattern, "iu").test(vehicle.label))
		return "staff"
	const plates = config.test_plates.map(normalisePlate)
	if (vehicle.plate && plates.includes(normalisePlate(vehicle.plate))) return "test"
	if (plates.includes(normalisePlate(vehicle.externalId))) return "test"
	return null
}
