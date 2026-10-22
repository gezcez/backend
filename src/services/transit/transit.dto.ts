// transit.dto.ts

import { createZodDto } from "nestjs-zod"
import { z } from "zod"
import {
	BBoxSchema,
	ModeSchema,
	RouteSummarySchema,
	StopSummarySchema,
} from "@common/models/transit.models"
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, pageSchema } from "@common/response"

/** "w,s,e,n" in a query string. */
export const BBoxParam = z
	.string()
	.transform((value, ctx) => {
		const parts = value.split(",").map(Number)
		if (
			parts.length !== 4 ||
			parts.some((n) => !Number.isFinite(n)) ||
			parts[0]! >= parts[2]! ||
			parts[1]! >= parts[3]!
		) {
			ctx.addIssue({ code: "custom", message: "bbox must be w,s,e,n" })
			return z.NEVER
		}
		return parts as [number, number, number, number]
	})
	.pipe(BBoxSchema)

export const RoutesQuerySchema = z.object({
	type: z.coerce.number().int().min(0).max(20).optional(),
	q: z.string().trim().min(1).max(100).optional(),
	limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).optional(),
	cursor: z.string().max(512).optional(),
})
export class RoutesQueryDto extends createZodDto(RoutesQuerySchema) {}

export class RoutePageDto extends createZodDto(pageSchema(RouteSummarySchema)) {}

export const RoutePatternStopSchema = StopSummarySchema.omit({ code: true }).extend({
	seq: z.number().int(),
	offset_s: z.number().int().nullable(),
})

export const RouteDetailSchema = RouteSummarySchema.extend({
	directions: z.array(
		z.object({
			direction: z.number().int(),
			headsign: z.string().nullable(),
			patterns: z.array(
				z.object({
					id: z.string(),
					headsign: z.string(),
					length_m: z.number().int(),
					stops: z.array(RoutePatternStopSchema),
				}),
			),
		}),
	),
})
export class RouteDetailDto extends createZodDto(RouteDetailSchema) {}

export const DirectionQuerySchema = z.object({
	direction: z.coerce.number().int().min(0).max(1).optional(),
})
export class DirectionQueryDto extends createZodDto(DirectionQuerySchema) {}

export const RouteShapeSchema = z.object({
	route_id: z.string(),
	precision: z.literal(6),
	shapes: z.array(
		z.object({ direction: z.number().int(), pattern_id: z.string(), polyline: z.string() }),
	),
})
export class RouteShapeDto extends createZodDto(RouteShapeSchema) {}

export const TimetableQuerySchema = z.object({
	direction: z.coerce.number().int().min(0).max(1).optional(),
	date: z.iso.date().optional(),
	day_type: z.enum(["weekday", "saturday", "sunday"]).optional(),
})
export class TimetableQueryDto extends createZodDto(TimetableQuerySchema) {}

export const TimetableSchema = z.object({
	route_id: z.string(),
	date: z.string().nullable(),
	day_type: z.enum(["weekday", "saturday", "sunday"]),
	service_labels: z.array(z.string()),
	patterns: z.array(
		z.object({
			id: z.string(),
			direction: z.number().int(),
			headsign: z.string(),
			stops: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					offset_s: z.number().int().nullable(),
				}),
			),
			departures: z.array(
				z.object({
					trip_id: z.string(),
					start: z.string(),
					start_s: z.number().int(),
					headsign: z.string().nullable(),
				}),
			),
		}),
	),
})
export class TimetableDto extends createZodDto(TimetableSchema) {}

export const StopsQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
	cursor: z.string().max(512).optional(),
	sort: z.string().max(200).optional(),
	q: z.string().trim().min(1).max(100).optional(),
	bbox: BBoxParam.optional(),
})
export class StopsQueryDto extends createZodDto(StopsQuerySchema) {}

export class StopPageDto extends createZodDto(pageSchema(StopSummarySchema)) {}

export const StopDetailSchema = StopSummarySchema.extend({ routes: z.array(RouteSummarySchema) })
export class StopDetailDto extends createZodDto(StopDetailSchema) {}

export const NearbyQuerySchema = z.object({
	lat: z.coerce.number().min(-90).max(90),
	lon: z.coerce.number().min(-180).max(180),
	radius: z.coerce.number().int().min(50).max(1500).default(500),
	network: z.string().max(64).optional(),
	limit: z.coerce.number().int().min(1).max(30).default(30),
})
export class NearbyQueryDto extends createZodDto(NearbyQuerySchema) {}

export const NearbySchema = z.object({
	items: z.array(
		StopSummarySchema.extend({
			distance_m: z.number().int(),
			route_ids: z.array(z.string()),
		}),
	),
})
export class NearbyDto extends createZodDto(NearbySchema) {}

export const SearchQuerySchema = z.object({
	q: z.string().trim().min(1).max(100),
	city: z.string().max(64).optional(),
	network: z.string().max(64).optional(),
	limit: z.coerce.number().int().min(1).max(50).default(20),
})
export class SearchQueryDto extends createZodDto(SearchQuerySchema) {}

export const SearchResultSchema = z.object({
	routes: z.array(RouteSummarySchema),
	stops: z.array(StopSummarySchema),
})
export class SearchResultDto extends createZodDto(SearchResultSchema) {}

export const SyncRunSchema = z.object({
	id: z.number().int(),
	binding_id: z.number().int(),
	version_id: z.number().int().nullable(),
	trigger: z.string(),
	status: z.enum(["running", "ok", "unchanged", "failed"]),
	started_at: z.string(),
	finished_at: z.string().nullable(),
	counts: z.record(z.string(), z.number()).nullable(),
	warnings: z.array(z.string()).nullable(),
	error: z.string().nullable(),
})
export class SyncRunPageDto extends createZodDto(pageSchema(SyncRunSchema)) {}

export { ModeSchema }

export const AlertSchema = z.object({
	id: z.string(),
	network_id: z.number().int(),
	title: z.string(),
	body: z.string(),
	severity: z.enum(["info", "warning", "severe"]),
	route_ids: z.array(z.string()),
	active_from: z.string(),
	active_to: z.string().nullable(),
	url: z.string().nullable(),
})
export class AlertDto extends createZodDto(AlertSchema) {}
