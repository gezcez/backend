// ws.protocol.ts
// The realtime protocol v1 (plan 6.10) as zod schemas. Client messages are validated with these;
// server messages are typed from them, and both are published in openapi.json under
// components.schemas (WsClientMessage, WsServerMessage) for the dashboard and mobile codegen.

import { z } from "zod"
import { BBoxSchema, DepartureSchema, VehicleRowSchema } from "@common/models/transit.models"

export const WS_PROTOCOL_VERSION = 1
export const WS_PATH = "/v1/ws"

export const WS_LIMITS = {
	max_subs: 8,
	max_routes_per_sub: 12,
	max_bbox_span_deg: 0.5,
	max_message_bytes: 4096,
	messages_per_10s: 30,
	subscribes_per_minute: 20,
	sockets_per_ip: 10,
} as const

export const WS_CLOSE = {
	malformed: 4400,
	authInvalid: 4401,
	rateLimited: 4429,
	goingAway: 1001,
	overloaded: 1013,
} as const

const SubId = z.string().min(1).max(64)

export const VehiclesParamsSchema = z.object({
	network: z.union([z.string().min(1).max(64), z.number().int()]).transform(String),
	routes: z.array(z.string().max(80)).max(WS_LIMITS.max_routes_per_sub).optional(),
	direction: z.union([z.literal(0), z.literal(1)]).optional(),
	bbox: BBoxSchema.optional(),
	detail: z.enum(["compact", "full"]).default("compact"),
})

export const DeparturesParamsSchema = z.object({
	stop: z.string().min(1).max(80),
	limit: z.number().int().min(1).max(30).default(10),
})

export const TrackerStatusParamsSchema = z.object({
	network: z
		.union([z.string().min(1).max(64), z.number().int()])
		.transform(String)
		.optional(),
})

export const TrackerLogsParamsSchema = z.object({ binding: z.number().int() })

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const

export const OpsLogsParamsSchema = z.object({
	/** Lowest level sent. */
	level: z.enum(LOG_LEVELS).default("info"),
	/** Recent lines sent on subscribe. */
	tail: z.number().int().min(0).max(500).default(100),
})

export const HealthParamsSchema = z.object({})
export const JobsParamsSchema = z.object({})

export const WS_CHANNELS = [
	"vehicles",
	"departures",
	"tracker.status",
	"tracker.logs",
	"ops.logs",
	"health",
	"jobs",
] as const

export const WsClientMessageSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("auth"), token: z.string().min(1).max(4000) }),
	z.object({
		type: z.literal("subscribe"),
		id: SubId,
		channel: z.enum(WS_CHANNELS),
		params: z.record(z.string(), z.unknown()).default({}),
	}),
	z.object({ type: z.literal("unsubscribe"), id: SubId }),
	z.object({ type: z.literal("ping"), t: z.number().optional() }),
	z.object({ type: z.literal("pong"), t: z.number().optional() }),
])
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>

const BindingState = z.enum(["ok", "degraded", "down", "paused", "killed", "unknown"])

export const WsServerMessageSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("hello"),
		v: z.literal(WS_PROTOCOL_VERSION),
		heartbeat_s: z.number().int(),
		limits: z.object({
			max_subs: z.number().int(),
			max_routes_per_sub: z.number().int(),
			max_bbox_span_deg: z.number(),
		}),
	}),
	z.object({ type: z.literal("auth_ok"), exp: z.number().int() }),
	z.object({
		type: z.literal("snapshot"),
		sub: z.string(),
		seq: z.number().int(),
		feed_ts: z.number().int().nullable(),
		fields: z.array(z.string()),
		vehicles: z.array(VehicleRowSchema),
	}),
	z.object({
		type: z.literal("delta"),
		sub: z.string(),
		seq: z.number().int(),
		feed_ts: z.number().int().nullable(),
		upsert: z.array(VehicleRowSchema),
		remove: z.array(z.string()),
	}),
	z.object({
		type: z.literal("departures"),
		sub: z.string(),
		seq: z.number().int(),
		stop: z.string(),
		generated_at: z.string(),
		items: z.array(DepartureSchema),
	}),
	z.object({
		type: z.literal("status"),
		sub: z.string(),
		seq: z.number().int(),
		network: z.number().int(),
		binding: z.number().int(),
		state: BindingState,
		message: z.string().nullable().optional(),
	}),
	z.object({
		type: z.literal("event"),
		sub: z.string(),
		seq: z.number().int(),
		data: z.unknown(),
	}),
	z.object({
		type: z.literal("error"),
		id: z.string().optional(),
		code: z.string(),
		message: z.string(),
	}),
	z.object({ type: z.literal("ping"), t: z.number() }),
	z.object({ type: z.literal("pong"), t: z.number().optional() }),
])
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>
