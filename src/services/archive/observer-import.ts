// observer-import.ts
// One-shot conversion of a kentkart-vts-observer `VTS.db` into the Parquet archive (plan 2.2,
// P3 "import kentkart-vts-observer history"), so analytics has history from day one.
//
// Per UTC day of feed time, in feed order:
// - dedup: the observer re-inserted unchanged positions every minute; a vehicle sample is kept
//   only when its vehicle timestamp is newer than the last kept one (the tracker's dedup key is
//   (vehicle, vehicle_ts), and this also drops out-of-order repeats across midnight);
// - drop invalid rows, staff duty routes (route prefix or GÖREVLİ trip labels) and test plates,
//   with the same defaults as the Kentkart binding config;
// - quality bits: stale (feed - vehicle > 600 s), jump (implied speed > 40 m/s), speed outlier;
// - vehicles get their vts.db ids (created when missing), so history and live data share ids;
// - trip runs are rebuilt per vehicle: a run ends on a trip (or route/direction) change, or
//   after a 10 min gap, and is archived on the UTC date of its end;
// - polls come from vts_metadata (one per stored feed).
// Each partition goes through ArchiveService.writePartition (read-back verification, sha256,
// manifest, upload). Days that already have a verified archive are left alone unless `force`.

import { haversineM } from "@common/utils"
import { normalisePlate, parseKentkartConfig } from "@services/providers/kentkart/kentkart.filters"
import { utcDate, utcDayStart, type Dataset } from "./archive.datasets"
import type { ArchiveRepository, RangeStats } from "./archive.repository"
import type { ArchiveService, DatasetExport } from "./archive.service"
import type { ObserverRepository, ObserverRow } from "./observer.repository"

const STALE_S = 600
const MAX_SPEED_MS = 40
const RUN_GAP_S = 600

export interface ObserverImportOptions {
	bindingId: number
	/** Re-import days that already have a verified archive. */
	force?: boolean
	/** Limit to UTC dates (inclusive). */
	from?: string
	to?: string
	staffRoutePrefixes?: string[]
	staffLabelPattern?: string
	testPlates?: string[]
	log?: (line: string) => void
}

export interface ObserverDayReport {
	date: string
	skipped: boolean
	datasets: DatasetExport[]
}

export interface ObserverImportReport {
	binding_id: number
	read: number
	kept: number
	duplicates: number
	staff: number
	test: number
	invalid: number
	runs: number
	days: ObserverDayReport[]
}

interface RunState {
	key: string
	route_ext: string | null
	direction: number | null
	trip_ext: string | null
	started_at: number
	last_ts: number
	first_seq: number | null
	last_seq: number | null
	max_seq: number | null
	samples: number
}

interface VehicleState {
	id: number
	ext: string
	plate: string | null
	first: number
	last: number
	lastTs: number
	lastLat: number
	lastLon: number
	run: RunState | null
}

/** Counts rows and tracks min/max of one column while they stream into DuckDB. */
function tracked(
	rows: unknown[][],
	column: number,
): { rows: unknown[][]; stats: () => RangeStats } {
	let min: number | null = null
	let max: number | null = null
	for (const row of rows) {
		const value = row[column] as number | null
		if (value === null) continue
		if (min === null || value < min) min = value
		if (max === null || value > max) max = value
	}
	return { rows, stats: () => ({ rows: rows.length, min, max }) }
}

export class ObserverImport {
	constructor(
		private readonly archive: ArchiveService,
		private readonly repository: ArchiveRepository,
	) {}

	async run(
		source: ObserverRepository,
		options: ObserverImportOptions,
	): Promise<ObserverImportReport> {
		const log = options.log ?? (() => {})
		const defaults = parseKentkartConfig({})
		const prefixes = options.staffRoutePrefixes ?? defaults.staff_route_prefixes
		const labelPattern = new RegExp(
			options.staffLabelPattern ?? defaults.staff_label_pattern,
			"iu",
		)
		const testPlates = new Set((options.testPlates ?? defaults.test_plates).map(normalisePlate))
		const staffRoutes = source.routesLabelled(labelPattern)
		const report: ObserverImportReport = {
			binding_id: options.bindingId,
			read: 0,
			kept: 0,
			duplicates: 0,
			staff: 0,
			test: 0,
			invalid: 0,
			runs: 0,
			days: [],
		}
		const { min, max } = source.range()
		if (min === null || max === null) return report
		const verified = new Set(
			this.repository
				.verifiedDays()
				.filter((d) => d.binding_id === options.bindingId)
				.map((d) => d.date),
		)
		const writable = (date: string) =>
			(options.force || !verified.has(date)) &&
			(!options.from || date >= options.from) &&
			(!options.to || date <= options.to)

		const vehicles = new Map<number, VehicleState>()
		const runsByDate = new Map<string, unknown[][]>()
		let runId = 0
		const closeRun = (vehicle: VehicleState, reason: string) => {
			const run = vehicle.run
			vehicle.run = null
			if (!run) return
			const date = utcDate(run.last_ts)
			runId--
			report.runs++
			const rows = runsByDate.get(date) ?? []
			rows.push([
				runId,
				vehicle.id,
				vehicle.ext,
				vehicle.plate,
				run.route_ext,
				run.direction,
				run.trip_ext,
				run.trip_ext === null,
				run.started_at,
				run.last_ts,
				reason,
				run.first_seq,
				run.last_seq,
				run.max_seq,
				run.samples,
				null,
				null,
			])
			runsByDate.set(date, rows)
		}

		const firstDay = utcDayStart(utcDate(min))
		const lastDay = utcDayStart(utcDate(max))
		const days = new Map<string, ObserverDayReport>()
		const write = async (date: string, dataset: Dataset, rows: unknown[][], column: number) => {
			if (!writable(date)) {
				if (!days.has(date)) days.set(date, { date, skipped: true, datasets: [] })
				return
			}
			const part = tracked(rows, column)
			const result = await this.archive.writePartition(
				options.bindingId,
				date,
				dataset,
				part.rows,
				part.stats,
			)
			const entry = days.get(date) ?? { date, skipped: false, datasets: [] }
			entry.datasets.push(result)
			days.set(date, entry)
			if (result.error) log(`${date} ${dataset}: FAILED ${result.error}`)
		}
		for (let day = firstDay; day <= lastDay; day += 86400) {
			const date = utcDate(day)
			const positions: unknown[][] = []
			for (const row of source.rows(day, day + 86400)) {
				report.read++
				const sample = this.sample(row)
				if (!sample) {
					report.invalid++
					continue
				}
				const routeExt = row.route_id === null ? null : String(row.route_id)
				if (
					(routeExt && prefixes.some((p) => routeExt.startsWith(p))) ||
					(row.route_id !== null && staffRoutes.has(row.route_id))
				) {
					report.staff++
					continue
				}
				if (
					testPlates.has(normalisePlate(row.plate ?? "")) ||
					testPlates.has(String(row.vehicle_id))
				) {
					report.test++
					continue
				}
				const ext = String(row.vehicle_id)
				let vehicle = vehicles.get(row.vehicle_id!)
				if (vehicle && sample.vehicleTs <= vehicle.lastTs) {
					report.duplicates++
					continue
				}
				let quality = row.created_at - sample.vehicleTs > STALE_S ? 1 : 0
				if ((row.speed ?? 0) > MAX_SPEED_MS) quality |= 8
				if (vehicle) {
					const dt = sample.vehicleTs - vehicle.lastTs
					const metres = haversineM(
						vehicle.lastLat,
						vehicle.lastLon,
						sample.lat,
						sample.lon,
					)
					if (metres / dt > MAX_SPEED_MS) quality |= 2
				} else {
					vehicle = {
						id: this.repository.ensureVehicle(
							options.bindingId,
							ext,
							row.plate,
							sample.vehicleTs,
							sample.vehicleTs,
						),
						ext,
						plate: row.plate,
						first: sample.vehicleTs,
						last: sample.vehicleTs,
						lastTs: 0,
						lastLat: sample.lat,
						lastLon: sample.lon,
						run: null,
					}
					vehicles.set(row.vehicle_id!, vehicle)
				}
				vehicle.lastTs = sample.vehicleTs
				vehicle.last = sample.vehicleTs
				vehicle.lastLat = sample.lat
				vehicle.lastLon = sample.lon
				vehicle.plate ??= row.plate
				report.kept++
				const tripExt = row.trip_id ? String(row.trip_id) : null
				this.track(
					vehicle,
					sample.vehicleTs,
					routeExt,
					row.direction,
					tripExt,
					row.stop_seq,
					closeRun,
				)
				positions.push([
					vehicle.id,
					ext,
					row.plate,
					sample.vehicleTs,
					row.created_at,
					routeExt,
					row.direction,
					tripExt,
					row.stop_id === null ? null : String(row.stop_id),
					row.stop_seq,
					row.status,
					Math.round(sample.lat * 1e6),
					Math.round(sample.lon * 1e6),
					row.bearing === null ? null : Math.round(row.bearing * 10),
					row.speed === null ? null : Math.min(32767, Math.round(row.speed * 100)),
					quality,
				])
			}
			const polls = source
				.polls(day, day + 86400)
				.map((p) => [
					-p.created_at,
					p.created_at,
					0,
					null,
					null,
					p.vehicle_count > 0 ? "ok" : "empty",
					p.created_at,
					p.vehicle_count,
					p.vehicle_count,
					p.vehicle_count,
					0,
					0,
					0,
					0,
					0,
					0,
					null,
				])
			// Positions and polls are final once their day is read; runs wait for the end.
			if (positions.length || polls.length) {
				await write(date, "positions", positions, 4)
				await write(date, "polls", polls, 1)
				log(`${date}: ${positions.length} positions, ${polls.length} polls`)
			}
		}
		for (const vehicle of vehicles.values()) {
			closeRun(vehicle, "disappeared")
			this.repository.ensureVehicle(
				options.bindingId,
				vehicle.ext,
				vehicle.plate,
				vehicle.first,
				vehicle.last,
			)
		}
		const runDates = new Set([...days.keys(), ...runsByDate.keys()])
		for (const date of [...runDates].sort()) {
			// Every archived day has the three datasets, even when one of them is empty.
			for (const dataset of ["positions", "polls"] as const)
				if (writable(date) && !days.get(date)?.datasets.some((d) => d.dataset === dataset))
					await write(date, dataset, [], dataset === "positions" ? 4 : 1)
			await write(date, "trip_runs", runsByDate.get(date) ?? [], 9)
		}
		report.days = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
		return report
	}

	private sample(row: ObserverRow): { vehicleTs: number; lat: number; lon: number } | null {
		if (row.vehicle_id === null || row.lat === null || row.lon === null) return null
		if (!row.vehicle_ts || row.vehicle_ts <= 0) return null
		if (Math.abs(row.lat) > 90 || Math.abs(row.lon) > 180 || (row.lat === 0 && row.lon === 0))
			return null
		return { vehicleTs: row.vehicle_ts, lat: row.lat, lon: row.lon }
	}

	private track(
		vehicle: VehicleState,
		ts: number,
		routeExt: string | null,
		direction: number | null,
		tripExt: string | null,
		stopSeq: number | null,
		closeRun: (vehicle: VehicleState, reason: string) => void,
	): void {
		const key = tripExt ? `t:${tripExt}` : `r:${routeExt}|${direction}`
		const run = vehicle.run
		if (run && ts - run.last_ts > RUN_GAP_S) closeRun(vehicle, "gap")
		else if (run && run.key !== key) closeRun(vehicle, "trip_change")
		if (!vehicle.run) {
			vehicle.run = {
				key,
				route_ext: routeExt,
				direction,
				trip_ext: tripExt,
				started_at: ts,
				last_ts: ts,
				first_seq: stopSeq,
				last_seq: stopSeq,
				max_seq: stopSeq,
				samples: 1,
			}
			return
		}
		const current = vehicle.run
		current.last_ts = ts
		current.samples++
		if (stopSeq !== null) {
			current.first_seq ??= stopSeq
			current.last_seq = stopSeq
			current.max_seq = Math.max(current.max_seq ?? stopSeq, stopSeq)
		}
	}
}
