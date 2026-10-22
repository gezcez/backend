// test/helpers/observer-fixture.ts
// A small kentkart-vts-observer VTS.db (tables as in that repo's src/schema.ts, created by
// drizzle-kit push there) with the quirks the import must handle. Feeds every 60 s from
// 23:40 to 00:20 UTC across two UTC dates:
// - 1001 (route 100, trip 7001): vehicle timestamp moves every 120 s, so every other feed
//   repeats the previous sample (observer duplicates), one run across midnight;
// - 1002 (route 100): new sample every feed, trip 7002 until midnight then 7003;
// - 1003 plate BLD4TEST (test), 1004 route 41901 (staff prefix), 1005 route 500 whose trips are
//   labelled GÖREVLİ (staff), 1006 without coordinates (invalid);
// - 1007 (route 200): samples lag the feed by 700 s (stale) and one sample jumps 10 km.

import { Database } from "bun:sqlite"

export const OBSERVER_DAY = "2026-09-01"
export const OBSERVER_NEXT = "2026-09-02"
const START = Date.parse(`${OBSERVER_DAY}T23:40:00Z`) / 1000
export const OBSERVER_FEEDS = 41

const DDL = `
CREATE TABLE vts (
	created_at integer, vehicle_license_plate text(10), vehicle_id integer, direction integer,
	trip_route_id integer, trip_trip_id integer, trip_schedule_relationship integer,
	position_latitude real, position_longitude real, position_bearing real, position_speed real,
	current_stop_sequence integer, current_status integer, timestamp integer, stop_id integer
);
CREATE INDEX vts_created_at_index ON vts (created_at);
CREATE TABLE vts_metadata (created_at integer PRIMARY KEY NOT NULL, vehicle_count integer NOT NULL);
CREATE TABLE trips (
	id integer PRIMARY KEY NOT NULL, direction integer DEFAULT 0, trip_headsign text(200),
	trip_info text(400), route_name text(200), route_id integer NOT NULL,
	display_route_code text(10), agency_id integer, updated_at integer, created_at integer NOT NULL,
	departure_time text(5), pattern_color text(10), service_id integer, is_public integer,
	branched_display_route_code text(10), special_occasion text, gc_object_id text(16)
);
CREATE TABLE vehicles (
	id integer PRIMARY KEY NOT NULL, license_plate text(10) NOT NULL, created_at integer,
	last_seen integer, is_bicycle integer, is_accesible integer, is_ac integer, agency_id integer
);`

interface Sample {
	plate: string
	vehicle: number
	route: number
	trip: number
	lat: number | null
	lon: number
	ts: number
	seq: number
	speed: number
}

export interface ObserverExpectation {
	/** Distinct kept samples per UTC date of their first feed. */
	positions: Record<string, number>
	/** Kept vehicles (external ids). */
	vehicles: string[]
	duplicates: number
	staff: number
	test: number
	invalid: number
	read: number
}

export function writeObserverDb(file: string): ObserverExpectation {
	const db = new Database(file, { create: true })
	db.exec(DDL)
	db.run(
		`INSERT INTO trips (id, route_id, trip_headsign, route_name, created_at) VALUES
		 (1, 100, 'Merkez-Kampüs', 'Merkez-Kampüs', 0),
		 (2, 500, 'GÖREVLİ6-GÖREVLİ6', 'GÖREVLİ6', 0)`,
	)
	const insert = db.prepare(
		`INSERT INTO vts (created_at, vehicle_license_plate, vehicle_id, direction, trip_route_id,
		   trip_trip_id, position_latitude, position_longitude, position_bearing, position_speed,
		   current_stop_sequence, current_status, timestamp, stop_id)
		 VALUES (?, ?, ?, 0, ?, ?, ?, ?, 90, ?, ?, 2, ?, ?)`,
	)
	const meta = db.prepare("INSERT INTO vts_metadata (created_at, vehicle_count) VALUES (?, ?)")
	const seen = new Map<string, string>()
	const positions: Record<string, number> = {}
	let duplicates = 0
	let read = 0
	for (let i = 0; i < OBSERVER_FEEDS; i++) {
		const feed = START + i * 60
		const date = new Date(feed * 1000).toISOString().slice(0, 10)
		const step = Math.floor(i / 2)
		const samples: Sample[] = [
			{
				plate: "41 A 1",
				vehicle: 1001,
				route: 100,
				trip: 7001,
				lat: 40.76 + step * 0.001,
				lon: 29.92,
				ts: START + step * 120,
				seq: step + 1,
				speed: 8,
			},
			{
				plate: "41 A 2",
				vehicle: 1002,
				route: 100,
				trip: feed < START + 1200 ? 7002 : 7003,
				lat: 40.75 + i * 0.0005,
				lon: 29.93,
				ts: feed - 10,
				seq: i + 1,
				speed: 6,
			},
			{
				plate: "BLD4TEST",
				vehicle: 1003,
				route: 100,
				trip: 7004,
				lat: 40.7,
				lon: 29.9,
				ts: feed - 5,
				seq: 1,
				speed: 0,
			},
			{
				plate: "41 S 4",
				vehicle: 1004,
				route: 41901,
				trip: 7005,
				lat: 40.71,
				lon: 29.9,
				ts: feed - 5,
				seq: 1,
				speed: 0,
			},
			{
				plate: "41 S 5",
				vehicle: 1005,
				route: 500,
				trip: 7006,
				lat: 40.72,
				lon: 29.9,
				ts: feed - 5,
				seq: 1,
				speed: 0,
			},
			{
				plate: "41 X 6",
				vehicle: 1006,
				route: 100,
				trip: 7007,
				lat: null,
				lon: 29.9,
				ts: feed - 5,
				seq: 1,
				speed: 0,
			},
			{
				plate: "41 J 7",
				vehicle: 1007,
				route: 200,
				trip: 0,
				lat: i === 20 ? 40.85 : 40.74 + i * 0.0002,
				lon: 29.94,
				ts: feed - 700,
				seq: i + 1,
				speed: 5,
			},
		]
		for (const s of samples) {
			read++
			insert.run(
				feed,
				s.plate,
				s.vehicle,
				s.route,
				s.trip,
				s.lat,
				s.lon,
				s.speed,
				s.seq,
				s.ts,
				9000 + s.seq,
			)
			if (![1001, 1002, 1007].includes(s.vehicle)) continue
			const key = `${s.vehicle}:${s.ts}`
			if (seen.has(key)) {
				duplicates++
				continue
			}
			seen.set(key, date)
			positions[date] = (positions[date] ?? 0) + 1
		}
		meta.run(feed, samples.length)
	}
	db.close()
	return {
		positions,
		vehicles: ["1001", "1002", "1007"],
		duplicates,
		staff: OBSERVER_FEEDS * 2,
		test: OBSERVER_FEEDS,
		invalid: OBSERVER_FEEDS,
		read,
	}
}
