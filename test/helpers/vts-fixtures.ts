// test/helpers/vts-fixtures.ts
// Synthetic vts.db data with known answers for the archive and analytics tests.
//
// Per local day (Europe/Istanbul, UTC+3), one binding:
// - route R1 direction 0, stops S1..S5: trips V1 08:00 (T1, +60 s late), V2 08:10 (T2, +240 s),
//   V4 08:22 (T3, -120 s), V1 08:25 (T4, no timetable match);
// - route R2 direction 1, stops Q1..Q3: V3 09:00 (U1, on time), plus one stale sample at 09:30.
// Every trip: at each stop two STOPPED_AT samples 60 s apart (dwell 60 s, speed 0), between
// stops two IN_TRANSIT_TO samples (speed 10 m/s = 36 km/h), so stop arrivals are 240 s apart,
// an R1 run lasts 17 min and an R2 run 9 min. feed_ts = vehicle_ts + 15 (lag 15 s).
// Polls every 60 s from 07:55 to 09:35 local (101 per day); the first day has one upstream error.

import type { Database } from "bun:sqlite"
import { zonedInstant } from "@common/utils"

export const FIXTURE_TZ = "Europe/Istanbul"

interface Trip {
	vehicle: string
	route: string
	direction: number
	trip: string
	/** Local start, seconds after midnight. */
	start: number
	stops: string[]
	delay: number | null
	endReason: "trip_change" | "completed"
}

const R1 = ["S1", "S2", "S3", "S4", "S5"]
const R2 = ["Q1", "Q2", "Q3"]
const at = (h: number, m: number) => h * 3600 + m * 60

export const FIXTURE_TRIPS: Trip[] = [
	{
		vehicle: "V1",
		route: "R1",
		direction: 0,
		trip: "T1",
		start: at(8, 0),
		stops: R1,
		delay: 60,
		endReason: "trip_change",
	},
	{
		vehicle: "V2",
		route: "R1",
		direction: 0,
		trip: "T2",
		start: at(8, 10),
		stops: R1,
		delay: 240,
		endReason: "trip_change",
	},
	{
		vehicle: "V4",
		route: "R1",
		direction: 0,
		trip: "T3",
		start: at(8, 22),
		stops: R1,
		delay: -120,
		endReason: "trip_change",
	},
	{
		vehicle: "V1",
		route: "R1",
		direction: 0,
		trip: "T4",
		start: at(8, 25),
		stops: R1,
		delay: null,
		endReason: "trip_change",
	},
	{
		vehicle: "V3",
		route: "R2",
		direction: 1,
		trip: "U1",
		start: at(9, 0),
		stops: R2,
		delay: 0,
		endReason: "completed",
	},
]

export const VEHICLES = ["V1", "V2", "V3", "V4"]
/** Positions per local day (4 R1 trips x 18 + R2 10 + 1 stale). */
export const POSITIONS_PER_DAY = 4 * 18 + 10 + 1
export const POLLS_PER_DAY = 101

export interface PositionFixture {
	vehicle: string
	vehicle_ts: number
	feed_ts: number
	route_ext: string
	direction: number
	trip_ext: string
	stop_ext: string | null
	stop_seq: number | null
	status: number | null
	lat_e6: number
	lon_e6: number
	speed_cms: number
	quality: number
}

export interface FixtureData {
	positions: PositionFixture[]
	runs: {
		vehicle: string
		route_ext: string
		direction: number
		trip_ext: string
		started_at: number
		ended_at: number
		end_reason: string
		max_stop_seq: number
		samples: number
		scheduled_start_s: number | null
		start_delay_s: number | null
	}[]
	polls: { started_at: number; outcome: string; feed_ts: number; dropped: string | null }[]
}

export function buildFixture(dates: string[], tz = FIXTURE_TZ): FixtureData {
	const data: FixtureData = { positions: [], runs: [], polls: [] }
	dates.forEach((date, dayIndex) => {
		const midnight = zonedInstant(date, 0, tz)
		for (const trip of FIXTURE_TRIPS) {
			const t0 = midnight + trip.start
			let samples = 0
			trip.stops.forEach((stop, k) => {
				const tk = t0 + k * 240
				const base = {
					vehicle: trip.vehicle,
					route_ext: trip.route,
					direction: trip.direction,
					trip_ext: trip.trip,
					lon_e6: 29920000 + k * 2000,
					quality: 0,
				}
				for (const dt of [0, 60]) {
					data.positions.push({
						...base,
						vehicle_ts: tk + dt,
						feed_ts: tk + dt + 15,
						stop_ext: stop,
						stop_seq: k + 1,
						status: 1,
						lat_e6: 40760000 + k * 2000,
						speed_cms: 0,
					})
					samples++
				}
				if (k < trip.stops.length - 1)
					for (const dt of [120, 180]) {
						data.positions.push({
							...base,
							vehicle_ts: tk + dt,
							feed_ts: tk + dt + 15,
							stop_ext: trip.stops[k + 1]!,
							stop_seq: k + 2,
							status: 2,
							lat_e6: 40760000 + k * 2000 + 1000,
							speed_cms: 1000,
						})
						samples++
					}
			})
			const end = t0 + (trip.stops.length - 1) * 240 + 60
			data.runs.push({
				vehicle: trip.vehicle,
				route_ext: trip.route,
				direction: trip.direction,
				trip_ext: trip.trip,
				started_at: t0,
				ended_at: end,
				end_reason: trip.endReason,
				max_stop_seq: trip.stops.length,
				samples,
				scheduled_start_s: trip.delay === null ? null : trip.start - trip.delay,
				start_delay_s: trip.delay,
			})
		}
		const stale = midnight + at(9, 30)
		data.positions.push({
			vehicle: "V3",
			vehicle_ts: stale,
			feed_ts: stale + 700,
			route_ext: "R2",
			direction: 1,
			trip_ext: "U1",
			stop_ext: null,
			stop_seq: null,
			status: 2,
			lat_e6: 40770000,
			lon_e6: 29930000,
			speed_cms: 500,
			quality: 1,
		})
		for (let i = 0; i < POLLS_PER_DAY; i++) {
			const started = midnight + at(7, 55) + i * 60
			data.polls.push({
				started_at: started,
				outcome: dayIndex === 0 && i === 35 ? "upstream_error" : "ok",
				feed_ts: started - 5,
				dropped: i === 0 ? JSON.stringify({ staff: 1, test: 2 }) : null,
			})
		}
	})
	return data
}

/** Inserts the fixture into a migrated vts.db for `bindingId`. Returns vehicle ids by label. */
export function insertFixture(
	sqlite: Database,
	bindingId: number,
	data: FixtureData,
): Map<string, number> {
	const ids = new Map<string, number>()
	const first = Math.min(...data.positions.map((p) => p.vehicle_ts))
	const last = Math.max(...data.positions.map((p) => p.vehicle_ts))
	sqlite.transaction(() => {
		for (const label of VEHICLES) {
			const row = sqlite
				.query<{ id: number }, [number, string, string, number, number]>(
					`INSERT INTO vehicles (binding_id, external_id, plate, first_seen_at, last_seen_at)
					 VALUES (?, ?, ?, ?, ?) RETURNING id`,
				)
				.get(bindingId, label, `41 FX ${label}`, first, last)
			ids.set(label, row!.id)
		}
		const position = sqlite.query(
			`INSERT INTO positions (vehicle_id, vehicle_ts, feed_ts, binding_id, route_ext, direction,
			   trip_ext, stop_ext, stop_seq, status, lat_e6, lon_e6, bearing_d10, speed_cms, quality)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 900, ?, ?)`,
		)
		for (const p of data.positions)
			position.run(
				ids.get(p.vehicle)!,
				p.vehicle_ts,
				p.feed_ts,
				bindingId,
				p.route_ext,
				p.direction,
				p.trip_ext,
				p.stop_ext,
				p.stop_seq,
				p.status,
				p.lat_e6,
				p.lon_e6,
				p.speed_cms,
				p.quality,
			)
		const run = sqlite.query(
			`INSERT INTO trip_runs (binding_id, vehicle_id, route_ext, direction, trip_ext, started_at,
			   ended_at, end_reason, first_stop_seq, last_stop_seq, max_stop_seq, samples,
			   scheduled_start_s, start_delay_s)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
		)
		for (const r of data.runs)
			run.run(
				bindingId,
				ids.get(r.vehicle)!,
				r.route_ext,
				r.direction,
				r.trip_ext,
				r.started_at,
				r.ended_at,
				r.end_reason,
				r.max_stop_seq,
				r.max_stop_seq,
				r.samples,
				r.scheduled_start_s,
				r.start_delay_s,
			)
		const poll = sqlite.query(
			`INSERT INTO polls (binding_id, started_at, duration_ms, url_variant, http_status, outcome,
			   feed_ts, entities, accepted, inserted, dropped)
			 VALUES (?, ?, 120, 'primary', 200, ?, ?, 5, 5, 5, ?)`,
		)
		for (const p of data.polls)
			poll.run(bindingId, p.started_at, p.outcome, p.feed_ts, p.dropped)
	})()
	return ids
}
