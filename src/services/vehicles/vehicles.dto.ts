// vehicles.dto.ts
// Live vehicles, vehicle detail, departures and observed departures (plan 7.4).

import { createZodDto } from "nestjs-zod"
import { z } from "zod"
import {
	DepartureSchema,
	RouteSummarySchema,
	StopSummarySchema,
	VehicleRowSchema,
} from "@common/models/transit.models"
import { BBoxParam } from "@services/transit/transit.dto"
import { MAX_ROUTES_PER_SUB } from "./vehicles.service"

const csv = z
	.string()
	.max(2000)
	.transform((value) =>
		value
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	)
	.refine((list) => list.length <= MAX_ROUTES_PER_SUB, `At most ${MAX_ROUTES_PER_SUB} routes`)

export class VehiclesQueryDto extends createZodDto(
	z.object({
		routes: csv.optional().describe("Comma separated stable route ids (max 12)"),
		direction: z.coerce
			.number()
			.int()
			.refine((d) => d === 0 || d === 1, "direction is 0 or 1")
			.optional(),
		bbox: BBoxParam.optional().describe("w,s,e,n; max 0.5 degree span, snapped to z12 tiles"),
		detail: z
			.enum(["compact", "full"])
			.default("compact")
			.describe(
				"full adds plate, stop and headsign; needs a bearer token with the dash scope and vehicles.live.read",
			),
	}),
) {}

export const VehicleSnapshotSchema = z.object({
	network_id: z.number().int(),
	feed_ts: z.number().int().nullable().describe("Unix seconds of the newest poll"),
	status: z.enum(["active", "degraded", "disabled"]),
	message: z.string().nullable(),
	fields: z.array(z.string()),
	vehicles: z.array(VehicleRowSchema),
})
export class VehicleSnapshotDto extends createZodDto(VehicleSnapshotSchema) {}

const RunSchema = z.object({
	route_id: z.string().nullable(),
	direction: z.number().int().nullable(),
	trip_id: z.string().nullable(),
	started_at: z.string(),
	ended_at: z.string().nullable(),
	end_reason: z.string().nullable(),
	first_stop_seq: z.number().int().nullable(),
	last_stop_seq: z.number().int().nullable(),
	scheduled_start: z.string().nullable(),
	start_delay_s: z.number().int().nullable(),
})

export const VehicleDetailSchema = z.object({
	id: z.string(),
	network_id: z.number().int(),
	plate: z.string().nullable(),
	label: z.string().nullable(),
	live: z.boolean(),
	accessible: z.boolean().nullable(),
	last_seen_at: z.string(),
	position: z
		.object({
			lat: z.number(),
			lon: z.number(),
			bearing: z.number().nullable(),
			speed_ms: z.number().nullable(),
			vehicle_ts: z.number().int(),
			feed_ts: z.number().int(),
			stale: z.boolean(),
		})
		.nullable(),
	route: RouteSummarySchema.nullable(),
	direction: z.number().int().nullable(),
	trip_id: z.string().nullable(),
	stop_id: z.string().nullable(),
	stop_seq: z.number().int().nullable(),
	current_run: RunSchema.nullable(),
	runs_today: z.array(RunSchema),
})
export class VehicleDetailDto extends createZodDto(VehicleDetailSchema) {}

export class DeparturesQueryDto extends createZodDto(
	z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
) {}

export const DeparturesSchema = z.object({
	stop: StopSummarySchema,
	generated_at: z.string(),
	items: z.array(DepartureSchema),
})
export class DeparturesDto extends createZodDto(DeparturesSchema) {}

export class HistoryQueryDto extends createZodDto(
	z.object({
		direction: z.coerce.number().int().min(0).max(1).optional(),
		weekday: z.coerce.number().int().min(0).max(6).optional().describe("0 = Monday"),
	}),
) {}

export const HistoryDeparturesSchema = z.object({
	route: RouteSummarySchema,
	date: z.string(),
	weekday: z.number().int(),
	items: z.array(
		z.object({
			started_at: z.string(),
			clock: z.string(),
			direction: z.number().int().nullable(),
			trip_id: z.string().nullable(),
			scheduled_clock: z.string().nullable(),
			start_delay_s: z.number().int().nullable(),
			ended_at: z.string().nullable(),
			end_reason: z.string().nullable(),
		}),
	),
})
export class HistoryDeparturesDto extends createZodDto(HistoryDeparturesSchema) {}
