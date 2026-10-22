// assistant.controller.ts
// POST /v1/assistant/messages (scope `transit`): one assistant turn streamed as server-sent
// events. Off unless ASSISTANT_ENABLED and a key are set and the runtime kill switch allows it;
// rate limited per account and per IP. Errors before the stream opens use the JSON envelope.

import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common"
import {
	ApiDefaultResponse,
	ApiOperation,
	ApiProduces,
	ApiResponse,
	ApiTags,
} from "@nestjs/swagger"
import type { Request, Response } from "express"
import { InjectConfig, type AppConfig } from "@common/config"
import type { RequestAuth } from "@common/jwt.types"
import { CurrentAuth, RequireScope } from "@common/middlewares"
import { registerOpenApiDecorator } from "@common/openapi"
import { RateLimitService } from "@common/rate-limits"
import { clientIp } from "@common/utils"
import { z } from "zod"
import {
	AssistantMessagesBodyDto,
	AssistantStreamEventSchema,
	type AssistantStreamEvent,
} from "./assistant.dto"
import { AssistantService } from "./assistant.service"

const HEARTBEAT_MS = 15_000

// The SSE `data:` payloads are published so clients type their stream parser from openapi.json.
registerOpenApiDecorator((document) => {
	const { $schema: _ignored, ...schema } = z.toJSONSchema(AssistantStreamEventSchema, {
		target: "draft-2020-12",
	}) as Record<string, unknown>
	document.components ??= {}
	document.components.schemas = {
		...document.components.schemas,
		AssistantStreamEvent: schema,
	}
})

@ApiTags("assistant")
@Controller("assistant")
export class AssistantController {
	constructor(
		private readonly assistant: AssistantService,
		private readonly limits: RateLimitService,
		@InjectConfig() private readonly config: AppConfig,
	) {}

	@Post("messages")
	@HttpCode(200)
	@RequireScope("transit")
	@ApiOperation({
		summary: "Ask the trip assistant; streams AssistantStreamEvent frames (SSE)",
		description:
			"Each frame is `event: <type>` plus `data: <AssistantStreamEvent JSON>`. The stream ends after one `done` or `error` event. 503 FEATURE_DISABLED when the assistant is off. The optional `context.location` is used for nearby stops only and is never stored, logged or sent to the model.",
	})
	@ApiProduces("text/event-stream")
	@ApiResponse({
		status: 200,
		description: "Server-sent events",
		content: {
			"text/event-stream": {
				schema: { $ref: "#/components/schemas/AssistantStreamEvent" },
			},
		},
	})
	@ApiDefaultResponse({
		description: "Error envelope (before the stream opens)",
		schema: { $ref: "#/components/schemas/ErrorResponse" },
	})
	async messages(
		@CurrentAuth() auth: RequestAuth,
		@Body() body: AssistantMessagesBodyDto,
		@Req() req: Request,
		@Res() res: Response,
	): Promise<void> {
		this.assistant.assertEnabled()
		await this.limits.consume("assistant", {
			user: auth.publicId,
			ip: clientIp(req, this.config.trustCfHeaders),
		})

		res.status(200)
		res.setHeader("Content-Type", "text/event-stream; charset=utf-8")
		res.setHeader("Cache-Control", "no-store, no-transform")
		res.setHeader("X-Accel-Buffering", "no")
		res.flushHeaders()

		const aborter = new AbortController()
		res.on("close", () => {
			if (!res.writableEnded) aborter.abort()
		})
		const heartbeat = setInterval(() => {
			if (!res.writableEnded) res.write(": ping\n\n")
		}, HEARTBEAT_MS)
		const emit = (event: AssistantStreamEvent) => {
			if (res.writableEnded || aborter.signal.aborted) return
			res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		}
		try {
			await this.assistant.respond(body, emit, aborter.signal)
		} finally {
			clearInterval(heartbeat)
			if (!res.writableEnded) res.end()
		}
	}
}
