// observer.repository.ts
// Read-only access to a legacy kentkart-vts-observer `VTS.db` (plan 2.2) for the one-shot
// history import. Its `vts` table has no primary key and repeats unchanged positions every
// minute; timestamps are unix seconds (drizzle "timestamp" mode).

import { Database } from "bun:sqlite"

export interface ObserverRow {
	created_at: number
	plate: string | null
	vehicle_id: number | null
	direction: number | null
	route_id: number | null
	trip_id: number | null
	lat: number | null
	lon: number | null
	bearing: number | null
	speed: number | null
	stop_seq: number | null
	status: number | null
	vehicle_ts: number | null
	stop_id: number | null
}

export class ObserverRepository {
	private readonly db: Database

	constructor(file: string) {
		this.db = new Database(file, { readonly: true, strict: true })
		this.db.exec("PRAGMA busy_timeout = 5000")
	}

	/** First and last feed timestamps (created_at). */
	range(): { min: number | null; max: number | null } {
		const row = this.db
			.query<{ lo: number | null; hi: number | null }, []>(
				"SELECT min(created_at) AS lo, max(created_at) AS hi FROM vts",
			)
			.get()
		return { min: row?.lo ?? null, max: row?.hi ?? null }
	}

	/** Rows of one feed-time range in feed order. */
	*rows(from: number, to: number): Generator<ObserverRow> {
		const statement = this.db.prepare<ObserverRow, [number, number]>(
			`SELECT created_at, vehicle_license_plate AS plate, vehicle_id, direction,
			        trip_route_id AS route_id, trip_trip_id AS trip_id,
			        position_latitude AS lat, position_longitude AS lon,
			        position_bearing AS bearing, position_speed AS speed,
			        current_stop_sequence AS stop_seq, current_status AS status,
			        timestamp AS vehicle_ts, stop_id
			 FROM vts WHERE created_at >= ? AND created_at < ?
			 ORDER BY created_at, vehicle_id`,
		)
		try {
			yield* statement.iterate(from, to)
		} finally {
			statement.finalize()
		}
	}

	/** One poll per stored feed (vts_metadata). */
	polls(from: number, to: number): { created_at: number; vehicle_count: number }[] {
		if (!this.hasTable("vts_metadata")) return []
		return this.db
			.query<{ created_at: number; vehicle_count: number }, [number, number]>(
				`SELECT created_at, vehicle_count FROM vts_metadata
				 WHERE created_at >= ? AND created_at < ? ORDER BY created_at`,
			)
			.all(from, to)
	}

	/** Route ids whose trips are labelled like staff duty services (`trips` headsigns). */
	routesLabelled(pattern: RegExp): Set<number> {
		const out = new Set<number>()
		if (!this.hasTable("trips")) return out
		const rows = this.db
			.query<{ route_id: number; label: string | null; name: string | null }, []>(
				"SELECT DISTINCT route_id, trip_headsign AS label, route_name AS name FROM trips",
			)
			.all()
		for (const row of rows)
			if ((row.label && pattern.test(row.label)) || (row.name && pattern.test(row.name)))
				out.add(row.route_id)
		return out
	}

	private hasTable(name: string): boolean {
		return Boolean(
			this.db
				.query<{ n: number }, [string]>(
					"SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
				)
				.get(name)?.n,
		)
	}

	close(): void {
		this.db.close()
	}
}
