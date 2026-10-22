// aggregates.paths.ts
// Layout of the materialised aggregates (plan 5.4):
//   data/agg/fleet_hourly/region=<id>/date=YYYY-MM-DD/part.parquet
//   data/agg/headways/region=<id>/date=YYYY-MM-DD/part.parquet
//   data/agg/segment_times/region=<id>/week=YYYY-Www/part.parquet

import path from "node:path"

export type DailyAggregate = "fleet_hourly" | "headways"

export function aggFile(
	aggDir: string,
	kind: DailyAggregate,
	region: number,
	date: string,
): string {
	return path.join(aggDir, kind, `region=${region}`, `date=${date}`, "part.parquet")
}

export function aggWeekFile(aggDir: string, region: number, week: string): string {
	return path.join(aggDir, "segment_times", `region=${region}`, `week=${week}`, "part.parquet")
}
