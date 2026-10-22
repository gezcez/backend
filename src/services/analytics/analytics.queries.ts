// analytics.queries.ts
// Parameterised SQL for every metric of plan 6.9. Each query reads the per-request temp views
// that AnalyticsService builds over Parquet partitions and hot vts.db rows:
//   positions (region, vehicle_id, vehicle_ext, plate, vehicle_ts, feed_ts, route_ext, direction,
//              trip_ext, stop_ext, stop_seq, status, lat_e6, lon_e6, bearing_d10, speed_cms,
//              quality)  -- feed_ts inside the window
//   trip_runs  (region, id, vehicle_id, ..., started_at, ended_at, end_reason, ...,
//              start_delay_s)  -- started_at inside the window
//   polls      (region, id, started_at, outcome, feed_ts, dropped_*)  -- started_at in window
//   routes     (region, route_ext, short_name)  -- the active catalogue
// and the macro lt(ts): a UTC TIMESTAMP as local time of the network.
// Literals are inlined (COPY cannot take parameters); every input is validated by the DTO first
// and strings go through sqlString().

import { sqlString } from "./duckdb.service"

export const METRIC_KEYS = [
	"fleet.hourly",
	"fleet.vehicle-days",
	"runs.runtime",
	"runs.departures",
	"headways.observed",
	"adherence.departure",
	"speed.heatmap",
	"segments.travel-time",
	"dwell.stops",
	"quality.feed",
	"coverage.routes",
	"headways.marey",
] as const
export type MetricKey = (typeof METRIC_KEYS)[number]

export type View = "positions" | "trip_runs" | "polls" | "routes"

export interface MetricParams {
	/** Local dates, inclusive. */
	from: string
	to: string
	routes: string[]
	direction?: number
	day_type: "all" | "weekday" | "saturday" | "sunday"
	hour_from: number
	hour_to: number
	granularity: "5m" | "1h" | "1d"
	res: number
	hour?: number
	min_samples: number
	min_stops: number
	stop_id?: string
	limit: number
}

export interface MetricContext {
	params: MetricParams
	/** Days in the window (to - from + 1). */
	days: number
}

export interface MetricDef {
	key: MetricKey
	views: View[]
	description: string
	/** Problems with the parameters for this metric (VALIDATION_FAILED). */
	validate?(params: MetricParams): string | null
	sql(ctx: MetricContext): string
}

const ISO_MINUTE = "'%Y-%m-%dT%H:%M'"
const ISO_SECOND = "'%Y-%m-%dT%H:%M:%S'"
const ISO_DATE = "'%Y-%m-%d'"
const OK_OUTCOMES = "('ok', 'empty', 'duplicate_header')"

/** Route, direction, day type and hour range conditions on a timestamp column. */
export function filters(
	p: MetricParams,
	ts: string,
	options: { routes?: boolean; hours?: boolean } = {},
): string {
	const parts: string[] = ["TRUE"]
	if (options.routes !== false) {
		if (p.routes.length) parts.push(`route_ext IN (${p.routes.map(sqlString).join(", ")})`)
		if (p.direction !== undefined) parts.push(`direction = ${p.direction}`)
	}
	if (p.day_type === "weekday") parts.push(`isodow(lt(${ts})) BETWEEN 1 AND 5`)
	else if (p.day_type === "saturday") parts.push(`isodow(lt(${ts})) = 6`)
	else if (p.day_type === "sunday") parts.push(`isodow(lt(${ts})) = 7`)
	if (options.hours !== false && (p.hour_from > 0 || p.hour_to < 23))
		parts.push(`hour(lt(${ts})) BETWEEN ${p.hour_from} AND ${p.hour_to}`)
	return parts.join(" AND ")
}

/** Arrival at a stop: the first STOPPED_AT sample, else the first sample at it. */
const ARRIVAL =
	"coalesce(min(vehicle_ts) FILTER (WHERE status = 1 OR status IS NULL), min(vehicle_ts))"

const seconds = (a: string, b: string) => `date_diff('second', ${a}, ${b})`

function fleetBucket(granularity: MetricParams["granularity"], column: string): string {
	if (granularity === "1d") return `date_trunc('day', ${column})`
	if (granularity === "1h") return `date_trunc('hour', ${column})`
	return column
}

export const METRICS: Record<MetricKey, MetricDef> = {
	"fleet.hourly": {
		key: "fleet.hourly",
		views: ["positions"],
		description:
			"Distinct vehicles per bucket, vehicle-hours (5 min presence slots / 12) and peak fleet (max vehicles in one 5 min slot)",
		sql: ({ params: p }) => `
			WITH slots AS (
				SELECT DISTINCT region, vehicle_id, time_bucket(INTERVAL 5 MINUTE, lt(vehicle_ts)) AS slot
				FROM positions WHERE quality & 3 = 0 AND ${filters(p, "vehicle_ts")}
			), per_slot AS (
				SELECT slot, count(*) AS v FROM slots GROUP BY slot
			), agg AS (
				SELECT ${fleetBucket(p.granularity, "slot")} AS b,
				       count(DISTINCT (region, vehicle_id)) AS vehicles,
				       round(count(*) / 12.0, 2) AS vehicle_hours
				FROM slots GROUP BY 1
			), peak AS (
				SELECT ${fleetBucket(p.granularity, "slot")} AS b, max(v) AS peak_vehicles
				FROM per_slot GROUP BY 1
			)
			SELECT strftime(b, ${p.granularity === "1d" ? ISO_DATE : ISO_MINUTE}) AS bucket,
			       vehicles, vehicle_hours, peak_vehicles
			FROM agg JOIN peak USING (b) ORDER BY b`,
	},

	"fleet.vehicle-days": {
		key: "fleet.vehicle-days",
		views: ["positions"],
		description:
			"Per vehicle and local day: first and last seen (duty span), samples, routes; new/retired flags inside the window",
		sql: ({ params: p }) => `
			WITH d AS (
				SELECT region, vehicle_id, any_value(vehicle_ext) AS vehicle_ext, any_value(plate) AS plate,
				       lt(vehicle_ts)::DATE AS day, min(lt(vehicle_ts)) AS first_seen,
				       max(lt(vehicle_ts)) AS last_seen, count(*) AS samples,
				       count(DISTINCT route_ext) AS routes
				FROM positions WHERE quality & 3 = 0 AND ${filters(p, "vehicle_ts")}
				GROUP BY region, vehicle_id, day
			), b AS (
				SELECT region, vehicle_id, min(day) AS first_day, max(day) AS last_day
				FROM d GROUP BY region, vehicle_id
			)
			SELECT strftime(day, ${ISO_DATE}) AS date, region AS binding_id, vehicle_id, vehicle_ext, plate,
			       strftime(first_seen, ${ISO_SECOND}) AS first_seen,
			       strftime(last_seen, ${ISO_SECOND}) AS last_seen,
			       round(${seconds("first_seen", "last_seen")} / 3600.0, 2) AS duty_hours,
			       samples, routes,
			       (day = first_day AND day > DATE ${sqlString(p.from)}) AS new_in_window,
			       (day = last_day AND day < DATE ${sqlString(p.to)}) AS retired_in_window
			FROM d JOIN b USING (region, vehicle_id)
			ORDER BY day, region, vehicle_id`,
	},

	"runs.runtime": {
		key: "runs.runtime",
		views: ["trip_runs"],
		description:
			"Trip runtime p50/p90 per route-direction and start hour; completed runs (trip_change, completed) with max_stop_seq >= min_stops",
		sql: ({ params: p }) => `
			WITH r AS (
				SELECT route_ext, direction, hour(lt(started_at)) AS hour,
				       ${seconds("started_at", "ended_at")} / 60.0 AS minutes
				FROM trip_runs
				WHERE ended_at IS NOT NULL AND end_reason IN ('trip_change', 'completed')
				  AND coalesce(max_stop_seq, 0) >= ${p.min_stops} AND ${filters(p, "started_at")}
			)
			SELECT route_ext, direction, hour, count(*) AS runs,
			       round(quantile_cont(minutes, 0.5), 2) AS p50_min,
			       round(quantile_cont(minutes, 0.9), 2) AS p90_min,
			       round(avg(minutes), 2) AS mean_min
			FROM r GROUP BY ALL ORDER BY route_ext, direction, hour`,
	},

	"runs.departures": {
		key: "runs.departures",
		views: ["trip_runs"],
		description:
			"Observed trip starts per route-direction and local day (runs with 2+ samples)",
		sql: ({ params: p }) => `
			SELECT strftime(lt(started_at)::DATE, ${ISO_DATE}) AS date, route_ext, direction,
			       count(*) AS departures
			FROM trip_runs WHERE samples >= 2 AND ${filters(p, "started_at")}
			GROUP BY ALL ORDER BY date, route_ext, direction`,
	},

	"headways.observed": {
		key: "headways.observed",
		views: ["positions"],
		description:
			"Observed headways per route-direction-stop and hour; bunching = headway < 0.5 x the stop's median, gap = > 2 x median",
		sql: ({ params: p }) => `
			WITH a AS (
				SELECT region, route_ext, direction, stop_ext, vehicle_id, trip_ext,
				       lt(vehicle_ts)::DATE AS day, ${ARRIVAL} AS arr
				FROM positions
				WHERE quality = 0 AND stop_ext IS NOT NULL AND route_ext IS NOT NULL
				  AND ${filters(p, "vehicle_ts", { hours: false })}
				GROUP BY region, route_ext, direction, stop_ext, vehicle_id, trip_ext, day
			), g AS (
				SELECT *, hour(lt(arr)) AS hour,
				       ${seconds(
							"lag(arr) OVER (PARTITION BY region, route_ext, direction, stop_ext, day ORDER BY arr)",
							"arr",
						)} / 60.0 AS headway_min
				FROM a
			), m AS (
				SELECT region, route_ext, direction, stop_ext, median(headway_min) AS med
				FROM g WHERE headway_min IS NOT NULL GROUP BY ALL
			)
			SELECT route_ext, direction, stop_ext, hour, count(*) AS n,
			       round(median(headway_min), 2) AS median_headway_min,
			       round(quantile_cont(headway_min, 0.9), 2) AS p90_headway_min,
			       round(avg((headway_min < 0.5 * m.med)::INT), 3) AS bunching_share,
			       round(avg((headway_min > 2 * m.med)::INT), 3) AS gap_share
			FROM g JOIN m USING (region, route_ext, direction, stop_ext)
			WHERE headway_min IS NOT NULL AND hour BETWEEN ${p.hour_from} AND ${p.hour_to}
			GROUP BY ALL ORDER BY route_ext, direction, stop_ext, hour`,
	},

	"adherence.departure": {
		key: "adherence.departure",
		views: ["trip_runs", "routes"],
		description:
			"Start delay vs timetable per route-direction and hour: median and p90 (min), on time = |delay| <= 3 min, early < -1 min, late > +5 min",
		sql: ({ params: p }) => `
			SELECT t.route_ext, any_value(r.short_name) AS short_name, t.direction,
			       hour(lt(t.started_at)) AS hour, count(*) AS runs,
			       round(median(t.start_delay_s) / 60.0, 2) AS median_delay_min,
			       round(quantile_cont(t.start_delay_s, 0.9) / 60.0, 2) AS p90_delay_min,
			       round(avg((abs(t.start_delay_s) <= 180)::INT), 3) AS on_time_share,
			       round(avg((t.start_delay_s < -60)::INT), 3) AS early_share,
			       round(avg((t.start_delay_s > 300)::INT), 3) AS late_share
			FROM (SELECT * FROM trip_runs WHERE start_delay_s IS NOT NULL AND ${filters(p, "started_at")}) t
			LEFT JOIN routes r ON r.region = t.region AND r.route_ext = t.route_ext
			GROUP BY t.route_ext, t.direction, hour ORDER BY t.route_ext, t.direction, hour`,
	},

	"speed.heatmap": {
		key: "speed.heatmap",
		views: ["positions"],
		description:
			"Median and p15 speed (km/h) per H3 cell; clean samples with 0-30 m/s; cells with n >= min_samples",
		sql: ({ params: p }) => `
			WITH s AS (
				SELECT floor(lat_e6 / 100)::INTEGER AS a, floor(lon_e6 / 100)::INTEGER AS b,
				       speed_cms * 0.036::DOUBLE AS kmh
				FROM positions
				WHERE quality = 0 AND speed_cms BETWEEN 0 AND 3000 AND ${filters(p, "vehicle_ts")}
				  ${p.hour === undefined ? "" : `AND hour(lt(vehicle_ts)) = ${p.hour}`}
			), c AS (
				SELECT a, b, gz_h3((a + 0.5) / 1e4, (b + 0.5) / 1e4, ${p.res}) AS h3
				FROM (SELECT DISTINCT a, b FROM s)
			)
			SELECT h3, round(quantile_cont(kmh, 0.5), 2) AS median_kmh,
			       round(quantile_cont(kmh, 0.15), 2) AS p15_kmh, count(*) AS n
			FROM s JOIN c USING (a, b)
			GROUP BY h3 HAVING count(*) >= ${p.min_samples} ORDER BY h3`,
	},

	"segments.travel-time": {
		key: "segments.travel-time",
		views: ["positions"],
		description:
			"Median and p90 travel time (s) between consecutive stop sequences per route-direction and departure hour",
		sql: ({ params: p }) => `
			WITH a AS (
				SELECT region, route_ext, direction, vehicle_id, trip_ext, lt(vehicle_ts)::DATE AS day,
				       stop_seq, any_value(stop_ext) AS stop_ext, ${ARRIVAL} AS arr
				FROM positions
				WHERE quality = 0 AND stop_seq IS NOT NULL AND route_ext IS NOT NULL
				  AND ${filters(p, "vehicle_ts", { hours: false })}
				GROUP BY region, route_ext, direction, vehicle_id, trip_ext, day, stop_seq
			), s AS (
				SELECT *, lead(stop_seq) OVER w AS next_seq, lead(stop_ext) OVER w AS next_stop,
				       lead(arr) OVER w AS next_arr
				FROM a WINDOW w AS (PARTITION BY region, route_ext, direction, vehicle_id, trip_ext, day ORDER BY stop_seq)
			)
			SELECT route_ext, direction, stop_seq AS from_seq, stop_ext AS from_stop, next_stop AS to_stop,
			       hour(lt(arr)) AS hour, count(*) AS n,
			       round(median(${seconds("arr", "next_arr")}), 1) AS median_s,
			       round(quantile_cont(${seconds("arr", "next_arr")}, 0.9), 1) AS p90_s
			FROM s
			WHERE next_seq = stop_seq + 1 AND next_arr > arr
			  AND hour(lt(arr)) BETWEEN ${p.hour_from} AND ${p.hour_to}
			GROUP BY ALL ORDER BY route_ext, direction, from_seq, hour`,
	},

	"dwell.stops": {
		key: "dwell.stops",
		views: ["positions"],
		description:
			"Dwell per stop: runs of consecutive STOPPED_AT samples (or speed <= 0.5 m/s without status) at one stop, 2+ samples, gaps <= 5 min",
		sql: ({ params: p }) => `
			WITH s AS (
				SELECT region, vehicle_id, vehicle_ts, stop_ext,
				       coalesce(status = 1, speed_cms <= 50, FALSE) AS stopped
				FROM positions WHERE quality & 3 = 0 AND ${filters(p, "vehicle_ts")}
			), k AS (
				SELECT *, CASE
				         WHEN stopped AND stop_ext IS NOT NULL
				          AND lag(stopped) OVER w AND lag(stop_ext) OVER w = stop_ext
				          AND ${seconds("lag(vehicle_ts) OVER w", "vehicle_ts")} <= 300
				         THEN 0 ELSE 1 END AS brk
				FROM s WINDOW w AS (PARTITION BY region, vehicle_id ORDER BY vehicle_ts)
			), i AS (
				SELECT *, sum(brk) OVER (PARTITION BY region, vehicle_id ORDER BY vehicle_ts) AS island
				FROM k
			), e AS (
				SELECT region, vehicle_id, island, any_value(stop_ext) AS stop_ext,
				       min(vehicle_ts) AS t0, max(vehicle_ts) AS t1
				FROM i WHERE stopped AND stop_ext IS NOT NULL
				GROUP BY region, vehicle_id, island HAVING count(*) >= 2
			)
			SELECT stop_ext, ${p.stop_id === undefined ? "" : "hour(lt(t0)) AS hour, "}count(*) AS n,
			       round(median(${seconds("t0", "t1")}), 1) AS median_dwell_s,
			       round(quantile_cont(${seconds("t0", "t1")}, 0.9), 1) AS p90_dwell_s
			FROM e ${p.stop_id === undefined ? "" : `WHERE stop_ext = ${sqlString(p.stop_id)}`}
			GROUP BY ALL
			ORDER BY ${p.stop_id === undefined ? "median_dwell_s DESC, n DESC, stop_ext" : "hour"}
			LIMIT ${p.limit}`,
	},

	"quality.feed": {
		key: "quality.feed",
		views: ["positions", "polls", "routes"],
		description:
			"Per binding and local day: poll success, gap minutes (poll gaps > 5 min), feed lag p50/p95, stale and outlier shares, drops, route coverage; score = 100 x (0.4 success + 0.3 (1 - stale) + 0.2 coverage + 0.1 (1 - outliers))",
		sql: ({ params: p }) => `
			WITH pl AS (
				SELECT region, lt(started_at)::DATE AS day, outcome,
				       ${seconds(
							"lag(started_at) OVER (PARTITION BY region ORDER BY started_at)",
							"started_at",
						)} AS gap_s,
				       dropped_test, dropped_staff, dropped_stale, dropped_out_of_bbox, dropped_invalid
				FROM polls WHERE ${filters(p, "started_at", { routes: false, hours: false })}
			), pq AS (
				SELECT region, day, count(*) AS polls,
				       count(*) FILTER (WHERE outcome NOT LIKE 'skipped%') AS attempted,
				       count(*) FILTER (WHERE outcome IN ${OK_OUTCOMES}) AS succeeded,
				       round(coalesce(sum(gap_s) FILTER (WHERE gap_s > 300), 0) / 60.0, 1) AS gap_minutes,
				       sum(dropped_test) AS dropped_test, sum(dropped_staff) AS dropped_staff,
				       sum(dropped_stale) AS dropped_stale, sum(dropped_out_of_bbox) AS dropped_out_of_bbox,
				       sum(dropped_invalid) AS dropped_invalid
				FROM pl GROUP BY region, day
			), pp AS (
				SELECT region, lt(feed_ts)::DATE AS day, count(*) AS positions,
				       count(DISTINCT vehicle_id) AS vehicles,
				       quantile_cont(${seconds("vehicle_ts", "feed_ts")}, 0.5) AS lag_p50_s,
				       quantile_cont(${seconds("vehicle_ts", "feed_ts")}, 0.95) AS lag_p95_s,
				       avg((quality & 1 > 0)::INT) AS stale_share,
				       avg((quality & 10 > 0)::INT) AS outlier_share,
				       count(DISTINCT route_ext) AS routes_seen
				FROM positions WHERE ${filters(p, "feed_ts", { routes: false, hours: false })}
				GROUP BY region, day
			), rc AS (
				SELECT region, count(*) AS catalog_routes FROM routes GROUP BY region
			), j AS (
				SELECT region, day, coalesce(polls, 0) AS polls,
				       CASE WHEN attempted > 0 THEN succeeded / attempted ELSE NULL END AS success_rate,
				       coalesce(gap_minutes, 0) AS gap_minutes, coalesce(positions, 0) AS positions,
				       coalesce(vehicles, 0) AS vehicles, lag_p50_s, lag_p95_s,
				       coalesce(stale_share, 0) AS stale_share, coalesce(outlier_share, 0) AS outlier_share,
				       coalesce(routes_seen, 0) AS routes_seen, coalesce(catalog_routes, 0) AS catalog_routes,
				       CASE WHEN coalesce(catalog_routes, 0) = 0 THEN NULL
				            ELSE least(1.0, coalesce(routes_seen, 0) / catalog_routes) END AS coverage,
				       coalesce(dropped_test, 0) AS dropped_test, coalesce(dropped_staff, 0) AS dropped_staff,
				       coalesce(dropped_stale, 0) AS dropped_stale,
				       coalesce(dropped_out_of_bbox, 0) AS dropped_out_of_bbox,
				       coalesce(dropped_invalid, 0) AS dropped_invalid
				FROM pq FULL JOIN pp USING (region, day) LEFT JOIN rc USING (region)
			)
			SELECT strftime(day, ${ISO_DATE}) AS date, region AS binding_id, polls,
			       round(success_rate, 4) AS success_rate, gap_minutes, positions, vehicles,
			       lag_p50_s, lag_p95_s, round(stale_share, 4) AS stale_share,
			       round(outlier_share, 4) AS outlier_share, routes_seen, catalog_routes,
			       round(coverage, 4) AS coverage, dropped_test, dropped_staff, dropped_stale,
			       dropped_out_of_bbox, dropped_invalid,
			       round(100 * (0.4 * coalesce(success_rate, 0) + 0.3 * (1 - stale_share)
			                    + 0.2 * coalesce(coverage, 1) + 0.1 * (1 - outlier_share)), 1) AS score
			FROM j ORDER BY day, region`,
	},

	"coverage.routes": {
		key: "coverage.routes",
		views: ["positions", "routes"],
		description:
			"Catalogue routes and routes seen in the feed: days seen in the window (0 = never seen), last seen, vehicles",
		sql: ({ params: p, days }) => `
			WITH seen AS (
				SELECT region, route_ext, count(DISTINCT lt(vehicle_ts)::DATE) AS days_seen,
				       max(vehicle_ts) AS last_seen, count(DISTINCT vehicle_id) AS vehicles
				FROM positions
				WHERE route_ext IS NOT NULL AND quality & 3 = 0
				  AND ${filters(p, "vehicle_ts", { routes: false, hours: false })}
				GROUP BY region, route_ext
			)
			SELECT coalesce(s.region, r.region) AS binding_id, coalesce(s.route_ext, r.route_ext) AS route_ext,
			       r.short_name, (r.route_ext IS NOT NULL) AS in_catalog,
			       coalesce(s.days_seen, 0) AS days_seen, ${days} AS days_in_window,
			       strftime(lt(s.last_seen), ${ISO_SECOND}) AS last_seen, coalesce(s.vehicles, 0) AS vehicles
			FROM seen s FULL JOIN routes r ON r.region = s.region AND r.route_ext = s.route_ext
			${p.routes.length ? `WHERE coalesce(s.route_ext, r.route_ext) IN (${p.routes.map(sqlString).join(", ")})` : ""}
			ORDER BY days_seen, binding_id, route_ext`,
	},

	"headways.marey": {
		key: "headways.marey",
		views: ["positions"],
		description:
			"Time-distance series for one route-direction and day: one (t unix seconds, stop_seq) series per vehicle trip",
		validate: (p) => {
			if (p.routes.length !== 1) return "route_id is required (one route)"
			if (p.direction === undefined) return "direction is required"
			if (p.from !== p.to) return "one day only (date, or from = to)"
			return null
		},
		sql: ({ params: p }) => `
			SELECT vehicle_id, trip_ext, epoch(vehicle_ts)::BIGINT AS t, stop_seq
			FROM positions
			WHERE stop_seq IS NOT NULL AND quality & 3 = 0 AND ${filters(p, "vehicle_ts")}
			ORDER BY vehicle_id, trip_ext, vehicle_ts`,
	},
}
