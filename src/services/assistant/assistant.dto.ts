// assistant.dto.ts
// POST /v1/assistant/messages body and the server-sent events it streams back (docs/assistant.md).
// The conversation is kept by the client and sent whole each time; nothing is stored here.

import { createZodDto } from "nestjs-zod"
import { z } from "zod"
import {
	DepartureSchema,
	RouteSummarySchema,
	StopSummarySchema,
} from "@common/models/transit.models"
import { RouteDetailSchema, StopDetailSchema } from "@services/transit/transit.dto"

export const AssistantTurnSchema = z.object({
	role: z.enum(["user", "assistant"]),
	content: z.string().trim().min(1).max(4000),
})

export const AssistantLocationSchema = z
	.object({
		lat: z.number().min(-90).max(90),
		lon: z.number().min(-180).max(180),
	})
	.describe(
		"Sent only with the user's consent for this message; used for nearby stops, never stored, logged or sent to the model",
	)

export const AssistantContextSchema = z.object({
	city: z.string().max(64).optional().describe("City slug the user is browsing"),
	network: z.string().max(64).optional().describe("Network slug or id the user is browsing"),
	locale: z.enum(["tr", "en"]).default("tr"),
	location: AssistantLocationSchema.optional(),
})

export const AssistantMessagesBodySchema = z
	.object({
		messages: z
			.array(AssistantTurnSchema)
			.min(1)
			.max(20)
			.describe("The conversation so far, oldest first; the last turn is the user's"),
		context: AssistantContextSchema.default({ locale: "tr" }),
	})
	.refine((body) => body.messages[0]?.role === "user", {
		path: ["messages", 0, "role"],
		message: "the first turn must be the user's",
	})
	.refine((body) => body.messages.at(-1)?.role === "user", {
		path: ["messages"],
		message: "the last turn must be the user's",
	})
export class AssistantMessagesBodyDto extends createZodDto(AssistantMessagesBodySchema) {}
export type AssistantMessagesBody = z.infer<typeof AssistantMessagesBodySchema>
export type AssistantContext = z.infer<typeof AssistantContextSchema>

// ---------- stream events (SSE `event:` name = `type`) ----------

const NearbyStopSchema = StopSummarySchema.extend({
	distance_m: z.number().int(),
	route_ids: z.array(z.string()),
})

export const AssistantCardSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("departures"),
		data: z.object({
			stop: StopSummarySchema,
			generated_at: z.string(),
			items: z.array(DepartureSchema),
		}),
	}),
	z.object({ kind: z.literal("route"), data: RouteDetailSchema }),
	z.object({ kind: z.literal("stop"), data: StopDetailSchema }),
	z.object({ kind: z.literal("nearby"), data: z.object({ items: z.array(NearbyStopSchema) }) }),
	z.object({
		kind: z.literal("search"),
		data: z.object({ routes: z.array(RouteSummarySchema), stops: z.array(StopSummarySchema) }),
	}),
])
export type AssistantCard = z.infer<typeof AssistantCardSchema>

export const AssistantStopReasonSchema = z.enum([
	"end_turn",
	"max_tokens",
	"refusal",
	"max_rounds",
	"other",
])

export const AssistantStreamEventSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("start"), model: z.string() }),
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({
		type: z.literal("tool"),
		id: z.string(),
		name: z.string(),
		status: z.enum(["running", "done", "error"]),
	}),
	z.object({ type: z.literal("card"), card: AssistantCardSchema }),
	z.object({
		type: z.literal("done"),
		stop_reason: AssistantStopReasonSchema,
		usage: z.object({ input_tokens: z.number().int(), output_tokens: z.number().int() }),
	}),
	z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
])
export type AssistantStreamEvent = z.infer<typeof AssistantStreamEventSchema>
