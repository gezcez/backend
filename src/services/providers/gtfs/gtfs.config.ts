// gtfs.config.ts
// Binding config for a plain GTFS feed (non-secret, stored in provider_bindings.config and
// editable from the dashboard): the static zip, optional GTFS-RT feeds, request headers and the
// feed's time zone. Secret header values never live here; `secret_headers` names an env variable
// (GTFS_SECRET_*) that the process reads at request time.

import { z } from "zod"

const httpUrl = z.url({ protocol: /^https?$/ })

/** Env variables a binding may reference for secret headers (nothing else is reachable). */
export const GTFS_SECRET_ENV_PREFIX = "GTFS_SECRET_"

const headerName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "invalid header name")

export const GtfsBindingConfigSchema = z.object({
	/** GTFS static zip. */
	static_url: httpUrl,
	/** GTFS-RT VehiclePositions feed. */
	vehicle_positions_url: httpUrl.nullish(),
	/** GTFS-RT TripUpdates feed. */
	trip_updates_url: httpUrl.nullish(),
	/** GTFS-RT ServiceAlerts feed. */
	alerts_url: httpUrl.nullish(),
	/** Extra request headers sent to every feed URL (non-secret, e.g. Accept). */
	headers: z.record(headerName, z.string().max(1024)).default({}),
	/** Header name to env variable name for secret values (API keys). */
	secret_headers: z
		.record(
			headerName,
			z
				.string()
				.regex(
					new RegExp(`^${GTFS_SECRET_ENV_PREFIX}[A-Z0-9_]{1,64}$`),
					`must name a ${GTFS_SECRET_ENV_PREFIX}* env variable`,
				),
		)
		.default({}),
	/**
	 * Time zone of the feed's stop times. Defaults to agency_timezone, then the city's. When it
	 * differs from the city's, trip start times are shifted into the city's local day.
	 */
	timezone: z.string().min(1).nullish(),
	/** Text encoding of the CSV files (some feeds ship windows-1254). */
	encoding: z
		.string()
		.min(1)
		.refine((label) => {
			try {
				new TextDecoder(label as ConstructorParameters<typeof TextDecoder>[0])
				return true
			} catch {
				return false
			}
		}, "unknown text encoding")
		.default("utf-8"),
	/** Only import routes of these agency_ids (multi-operator feeds); empty imports all. */
	agency_ids: z.array(z.string()).default([]),
	/** Only import these GTFS route_types; empty imports all. */
	route_types: z.array(z.number().int().min(0)).default([]),
	/** Preferred language of GTFS-RT alert translations. */
	language: z.string().min(2).max(8).default("tr"),
	/** Human link to the dataset (dashboard and attribution). */
	dataset_url: httpUrl.nullish(),
	attribution: z.string().max(200).nullish(),
	request_timeout_ms: z.number().int().min(1000).max(60_000).default(10_000),
	static_timeout_ms: z.number().int().min(5000).max(600_000).default(120_000),
	/** Refuse static zips larger than this. */
	max_static_bytes: z
		.number()
		.int()
		.min(1024)
		.max(1024 * 1024 * 1024)
		.default(256 * 1024 * 1024),
})

export type GtfsBindingConfig = z.infer<typeof GtfsBindingConfigSchema>

export function parseGtfsConfig(raw: Record<string, unknown>): GtfsBindingConfig {
	return GtfsBindingConfigSchema.parse(raw ?? {})
}

/** Plain and secret headers for one request; a missing secret is reported, never guessed. */
export function requestHeaders(
	config: GtfsBindingConfig,
	secrets: Record<string, string>,
): { headers: Record<string, string>; missing: string[] } {
	const headers: Record<string, string> = { ...config.headers }
	const missing: string[] = []
	for (const [name, envName] of Object.entries(config.secret_headers)) {
		const value = secrets[envName]
		if (value) headers[name] = value
		else missing.push(envName)
	}
	return { headers, missing }
}
