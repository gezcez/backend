// transit-provider.interface.ts
// The provider seam (plan section 6.6). Every upstream (Kentkart, plain GTFS later, the fake
// provider) implements TransitProvider; nothing outside services/providers knows upstream shapes.

import type { PulledDataItem } from "@schemas/core"

export type RealtimeDeparturesLevel = "none" | "estimated" | "live"

export interface CardCapability {
	balance: boolean
	history: boolean
	requires_provider_account: boolean
	number_format: string | null
	label: { tr: string; en: string }
}

/** Capabilities per binding, merged per network for clients (plan section 6.5). */
export interface Capabilities {
	stops: boolean
	routes: boolean
	timetables: boolean
	shapes: boolean
	realtime_vehicles: boolean
	realtime_departures: RealtimeDeparturesLevel
	trip_updates: boolean
	alerts: boolean
	card: CardCapability | null
	trip_planner: false
	bike_share: false
}

export const NO_CAPABILITIES: Capabilities = {
	stops: false,
	routes: false,
	timetables: false,
	shapes: false,
	realtime_vehicles: false,
	realtime_departures: "none",
	trip_updates: false,
	alerts: false,
	card: null,
	trip_planner: false,
	bike_share: false,
}

export interface ProviderDescription {
	key: string
	name: string
	capabilities: Capabilities
	pulledData: PulledDataItem[]
	/** Upstream host and the polite request rate shared by tracker and static sync. */
	rateHint: { host: string; requestsPerSecond: number }
}

/** What an adapter gets to know about one binding. Secrets never travel in here. */
export interface BindingContext {
	id: number
	networkId: number
	providerKey: string
	externalRef: string
	config: Record<string, unknown>
	/** City bbox [w, s, e, n] used by the out-of-bbox flag. */
	bbox: [number, number, number, number] | null
	timezone: string
}

export interface ExternalRegion {
	externalRef: string
	name: string
	lat: number | null
	lon: number | null
	visible: boolean
}

// ---------- static data (GTFS shaped, external ids only) ----------

export interface StaticAgency {
	externalId: string
	name: string
	color?: string | null
	url?: string | null
	phone?: string | null
}

export interface StaticRoute {
	externalId: string
	shortName: string
	longName: string
	/** GTFS route_type: 0 tram, 3 bus, 4 ferry. */
	routeType: number
	color?: string | null
	textColor?: string | null
	agencyExternalId?: string | null
	isPublic: boolean
	sort?: number
}

export interface StaticStop {
	externalId: string
	name: string
	code?: string | null
	lat: number
	lon: number
	wheelchair?: number | null
}

export interface StaticPatternStop {
	stopExternalId: string
	/** Scheduled seconds from trip start, null when upstream does not say. */
	offsetS: number | null
	distM?: number | null
}

export interface StaticPattern {
	externalId: string
	routeExternalId: string
	direction: 0 | 1
	headsign: string
	/** [lat, lon] points in order. */
	shape: [number, number][]
	stops: StaticPatternStop[]
}

export interface StaticService {
	externalId: string
	/** Mon=1, Tue=2, ... Sun=64. */
	daysMask: number
	label?: string | null
}

export interface StaticTrip {
	externalId: string
	patternExternalId: string
	serviceExternalId: string
	/** Seconds after local midnight; may exceed 86400 for after-midnight trips. */
	startTimeS: number
	headsign?: string | null
	color?: string | null
}

export type StaticChunk =
	| { kind: "agencies"; items: StaticAgency[] }
	| { kind: "routes"; items: StaticRoute[] }
	| { kind: "stops"; items: StaticStop[] }
	| { kind: "patterns"; items: StaticPattern[] }
	| { kind: "services"; items: StaticService[] }
	| { kind: "trips"; items: StaticTrip[] }
	| { kind: "warning"; message: string }

// ---------- realtime ----------

/** One vehicle as the adapter normalised it (plan 6.6 and 8.5). */
export interface RawVehicle {
	externalId: string
	plate?: string
	label?: string
	routeExt?: string
	direction?: number
	tripExt?: string
	stopExt?: string
	stopSeq?: number
	/** GTFS VehicleStopStatus: 0 incoming, 1 stopped, 2 in transit. */
	status?: number
	lat: number
	lon: number
	bearing?: number
	speedMs?: number
	/** Unix seconds of the vehicle's own GPS fix. */
	vehicleTs: number
}

export type UrlVariant = "primary" | "fallback"

export interface VehicleFeed {
	/** Unix seconds from the feed header. */
	feedTs: number
	entities: RawVehicle[]
	urlVariant: UrlVariant
	bytes: number
	/** Entities the adapter could not use at all (no id or no position). */
	invalid: number
}

/** Card balance by number (capability `card`, no provider account). */
export interface CardBalance {
	balance: number
	currency: string
	/** Unix seconds of the upstream balance. */
	asOf: number
	cardType: string | null
}

export interface CardTransaction {
	/** Unix seconds. */
	at: number
	kind: "boarding" | "topup" | "transfer" | "other"
	amount: number
	balanceAfter: number | null
	routeShortName: string | null
}

export interface ServiceAlert {
	externalId: string
	title: string
	body: string
	severity: "info" | "warning" | "severe"
	routeExts: string[]
	/** Unix seconds. */
	activeFrom: number
	activeTo: number | null
	url: string | null
}

export type DropReason = "staff" | "test"

export type ProviderErrorKind =
	| "upstream_error"
	| "decode_error"
	| "timeout"
	| "empty"
	| "auth"
	| "auth_failed"
	| "rate_limited"
	| "disabled"

/** Thrown by adapters; the scheduler maps `kind` to poll outcomes and backoff. */
export class ProviderError extends Error {
	constructor(
		readonly kind: ProviderErrorKind,
		message: string,
		readonly details: {
			httpStatus?: number
			retryAfterS?: number
			urlVariant?: UrlVariant
			upstreamCode?: number
		} = {},
	) {
		super(message)
		this.name = "ProviderError"
	}
}

export interface TransitProvider {
	readonly key: string
	describe(): ProviderDescription
	listRegions?(): Promise<ExternalRegion[]>
	fetchStatic(binding: BindingContext, signal?: AbortSignal): AsyncIterable<StaticChunk>
	fetchVehicles(binding: BindingContext, signal: AbortSignal): Promise<VehicleFeed>
	/** Balance of a card; null when upstream does not know the number. Never persisted. */
	cardBalance?(
		binding: BindingContext,
		cardNumber: string,
		signal: AbortSignal,
	): Promise<CardBalance | null>
	/** A month (YYYY-MM) of card transactions; null when the number is unknown. */
	cardHistory?(
		binding: BindingContext,
		cardNumber: string,
		month: string,
		signal: AbortSignal,
	): Promise<{ currency: string; items: CardTransaction[] } | null>
	/** Service alerts, only for providers declaring the `alerts` capability. */
	fetchAlerts?(binding: BindingContext, signal: AbortSignal): Promise<ServiceAlert[]>
	/** Upstream rules that drop a vehicle entirely (staff duty routes, test devices). */
	classify?(vehicle: RawVehicle, binding: BindingContext): DropReason | null
	/** Clears a sticky fallback URL (dashboard "clear fallback"). */
	resetUrlVariant?(binding: BindingContext): void
	/** Forces a token refresh (dashboard "refresh token"). */
	refreshCredentials?(binding: BindingContext): Promise<void>
	/** Non-secret auth health for status pages; never the token. */
	credentialStatus?(binding: BindingContext): CredentialStatus | null
}

export interface CredentialStatus {
	realm: string
	state: "ok" | "missing" | "refreshing" | "auth_failed" | "unknown"
	expiresAt: number | null
	refreshedAt: number | null
	failures: number
	secretsSet: Record<string, boolean>
}
