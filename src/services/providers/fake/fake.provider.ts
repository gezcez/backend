// fake.provider.ts
// Deterministic provider for tests and `bun dev` without upstream credentials (plan 6.6).
// It serves a small synthetic network around the binding's city centre whose vehicles move along
// the timetable, so static data, live vehicles and departures agree. Tests can also script exact
// feeds per binding with `script()`.

import { localTime, weekdayBit } from "@common/utils"
import {
	NO_CAPABILITIES,
	ProviderError,
	type BindingContext,
	type DropReason,
	type ProviderDescription,
	type RawVehicle,
	type ServiceAlert,
	type StaticChunk,
	type StaticPattern,
	type StaticRoute,
	type StaticStop,
	type StaticTrip,
	type TransitProvider,
	type VehicleFeed,
} from "../transit-provider.interface"

export const FAKE_STOP_SPACING_S = 120
const STOPS_PER_PATTERN = 8
const HEADWAY_S = 15 * 60
const FIRST_DEPARTURE_S = 6 * 3600
const LAST_DEPARTURE_S = 23 * 3600

interface FakeRouteDef {
	ext: string
	short: string
	long: string
	color: string
	/** Bearing of the line through the centre, degrees. */
	angle: number
	routeType: number
}

const ROUTES: FakeRouteDef[] = [
	{ ext: "9001", short: "F1", long: "Merkez - Kuzey", color: "#d97706", angle: 0, routeType: 3 },
	{ ext: "9002", short: "F2", long: "Merkez - Doğu", color: "#172554", angle: 90, routeType: 3 },
	{ ext: "9003", short: "T1", long: "Tramvay Hattı", color: "#b45309", angle: 45, routeType: 0 },
]

const SERVICES = [
	{ externalId: "1", daysMask: 0b0011111, label: "MTWTFss" },
	{ externalId: "2", daysMask: 0b0100000, label: "mtwtfSs" },
	{ externalId: "3", daysMask: 0b1000000, label: "mtwtfsS" },
]

export type ScriptStep = VehicleFeed | ProviderError | ((now: number) => VehicleFeed)

function centre(binding: BindingContext): [number, number] {
	const c = binding.config.centre
	if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number")
		return [c[1], c[0]]
	if (binding.bbox) {
		const [w, s, e, n] = binding.bbox
		return [(s + n) / 2, (w + e) / 2]
	}
	return [40.7654, 29.9408]
}

function stopPoint(binding: BindingContext, route: FakeRouteDef, index: number): [number, number] {
	const [lat, lon] = centre(binding)
	const stepDeg = 0.004
	const offset = index - (STOPS_PER_PATTERN - 1) / 2
	const rad = (route.angle * Math.PI) / 180
	return [lat + Math.cos(rad) * offset * stepDeg, lon + Math.sin(rad) * offset * stepDeg * 1.3]
}

function stopExt(route: FakeRouteDef, index: number): string {
	return `${route.ext}${String(index).padStart(2, "0")}`
}

function tripExt(route: FakeRouteDef, direction: number, startS: number, service: string): string {
	return `${route.ext}${direction}${service}${String(startS / 60).padStart(4, "0")}`
}

export class FakeProvider implements TransitProvider {
	readonly key = "fake"
	private readonly scripts = new Map<number, ScriptStep[]>()
	private readonly calls = new Map<number, number>()
	private readonly alerts = new Map<number, ServiceAlert[] | ProviderError>()

	constructor(private readonly now: () => number = Date.now) {}

	describe(): ProviderDescription {
		return {
			key: this.key,
			name: "Fake provider",
			capabilities: {
				...NO_CAPABILITIES,
				stops: true,
				routes: true,
				timetables: true,
				shapes: true,
				realtime_vehicles: true,
				realtime_departures: "estimated",
				alerts: true,
			},
			pulledData: [
				{
					key: "synthetic",
					is_collected: false,
					can_optout: false,
					details: "Synthetic data for development and tests",
				},
			],
			rateHint: { host: "fake.local", requestsPerSecond: 100 },
		}
	}

	/** Queues exact feeds (or errors) for a binding; consumed one per poll. */
	script(bindingId: number, steps: ScriptStep[]): void {
		this.scripts.set(bindingId, [...steps])
	}

	/** Alerts (or an error) the binding reports from now on; none by default. */
	setAlerts(bindingId: number, alerts: ServiceAlert[] | ProviderError): void {
		this.alerts.set(bindingId, alerts)
	}

	fetchAlerts(binding: BindingContext, signal: AbortSignal): Promise<ServiceAlert[]> {
		signal.throwIfAborted()
		const alerts = this.alerts.get(binding.id) ?? []
		if (alerts instanceof ProviderError) return Promise.reject(alerts)
		return Promise.resolve(alerts)
	}

	clearScript(bindingId: number): void {
		this.scripts.delete(bindingId)
	}

	callCount(bindingId: number): number {
		return this.calls.get(bindingId) ?? 0
	}

	classify(vehicle: RawVehicle): DropReason | null {
		if (vehicle.label && /G[ÖO]REVL[İI]/iu.test(vehicle.label)) return "staff"
		if (vehicle.plate && vehicle.plate.replace(/\s+/g, "").toUpperCase() === "BLD4TEST")
			return "test"
		return null
	}

	patterns(binding: BindingContext): {
		routes: StaticRoute[]
		stops: StaticStop[]
		patterns: StaticPattern[]
		trips: StaticTrip[]
	} {
		const routes: StaticRoute[] = []
		const stops = new Map<string, StaticStop>()
		const patterns: StaticPattern[] = []
		const trips: StaticTrip[] = []
		ROUTES.forEach((route, sort) => {
			routes.push({
				externalId: route.ext,
				shortName: route.short,
				longName: route.long,
				routeType: route.routeType,
				color: route.color,
				textColor: "#fffbeb",
				agencyExternalId: "1",
				isPublic: true,
				sort,
			})
			for (let i = 0; i < STOPS_PER_PATTERN; i++) {
				const [lat, lon] = stopPoint(binding, route, i)
				stops.set(stopExt(route, i), {
					externalId: stopExt(route, i),
					name: `${route.short} Durak ${i + 1}`,
					code: stopExt(route, i),
					lat,
					lon,
				})
			}
			for (const direction of [0, 1] as const) {
				const order = Array.from({ length: STOPS_PER_PATTERN }, (_, i) =>
					direction === 0 ? i : STOPS_PER_PATTERN - 1 - i,
				)
				const patternId = `${route.ext}.${direction}`
				patterns.push({
					externalId: patternId,
					routeExternalId: route.ext,
					direction,
					headsign: `${route.short} ${direction === 0 ? "Kuzey" : "Merkez"}`,
					shape: order.map((i) => stopPoint(binding, route, i)),
					stops: order.map((i, seq) => ({
						stopExternalId: stopExt(route, i),
						offsetS: seq * FAKE_STOP_SPACING_S,
					})),
				})
				for (const service of SERVICES) {
					for (let t = FIRST_DEPARTURE_S; t <= LAST_DEPARTURE_S; t += HEADWAY_S) {
						trips.push({
							externalId: tripExt(route, direction, t, service.externalId),
							patternExternalId: patternId,
							serviceExternalId: service.externalId,
							startTimeS: t + direction * 300,
						})
					}
				}
			}
		})
		return { routes, stops: [...stops.values()], patterns, trips }
	}

	async *fetchStatic(binding: BindingContext): AsyncIterable<StaticChunk> {
		const data = this.patterns(binding)
		yield { kind: "agencies", items: [{ externalId: "1", name: "Fake Transit" }] }
		yield { kind: "routes", items: data.routes }
		yield { kind: "stops", items: data.stops }
		yield { kind: "services", items: SERVICES }
		yield { kind: "patterns", items: data.patterns }
		yield { kind: "trips", items: data.trips }
	}

	async fetchVehicles(binding: BindingContext, signal: AbortSignal): Promise<VehicleFeed> {
		signal.throwIfAborted()
		this.calls.set(binding.id, this.callCount(binding.id) + 1)
		const nowS = Math.floor(this.now() / 1000)
		const script = this.scripts.get(binding.id)
		if (script) {
			const step = script.length > 1 ? script.shift()! : script[0]
			if (!step) throw new ProviderError("empty", "fake script is empty")
			if (step instanceof ProviderError) throw step
			const feed = typeof step === "function" ? step(nowS) : step
			return Promise.resolve(feed)
		}
		return Promise.resolve(this.synthetic(binding, nowS))
	}

	/** Vehicles on every trip running at `nowS`, interpolated between stops. */
	synthetic(binding: BindingContext, nowS: number): VehicleFeed {
		const local = localTime(nowS, binding.timezone)
		const bit = weekdayBit(local.weekday)
		const service = SERVICES.find((s) => s.daysMask & bit)!.externalId
		const data = this.patterns(binding)
		const patternById = new Map(data.patterns.map((p) => [p.externalId, p]))
		const stopById = new Map(data.stops.map((s) => [s.externalId, s]))
		const entities: RawVehicle[] = []
		const duration = (STOPS_PER_PATTERN - 1) * FAKE_STOP_SPACING_S
		for (const trip of data.trips) {
			if (trip.serviceExternalId !== service) continue
			const elapsed = local.secondsOfDay - trip.startTimeS
			if (elapsed < 0 || elapsed > duration) continue
			const pattern = patternById.get(trip.patternExternalId)!
			const seg = Math.min(STOPS_PER_PATTERN - 2, Math.floor(elapsed / FAKE_STOP_SPACING_S))
			const frac = (elapsed - seg * FAKE_STOP_SPACING_S) / FAKE_STOP_SPACING_S
			const a = stopById.get(pattern.stops[seg]!.stopExternalId)!
			const b = stopById.get(pattern.stops[seg + 1]!.stopExternalId)!
			const slot = Math.round((trip.startTimeS - FIRST_DEPARTURE_S) / HEADWAY_S) % 3
			entities.push({
				externalId: `${pattern.routeExternalId}${pattern.direction}${slot}`,
				plate: `41 FK ${pattern.routeExternalId.slice(-2)}${pattern.direction}${slot}`,
				label: pattern.headsign,
				routeExt: pattern.routeExternalId,
				direction: pattern.direction,
				tripExt: trip.externalId,
				stopExt: b.externalId,
				stopSeq: seg + 2,
				status: frac > 0.9 ? 0 : 2,
				lat: a.lat + (b.lat - a.lat) * frac,
				lon: a.lon + (b.lon - a.lon) * frac,
				bearing: 0,
				speedMs: 6,
				vehicleTs: nowS - 5,
			})
		}
		return {
			feedTs: nowS,
			entities,
			urlVariant: "primary",
			bytes: entities.length * 60,
			invalid: 0,
		}
	}
}
