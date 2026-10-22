// assistant.service.ts
// The trip assistant loop (mobile plan L3, backend plan 6.17): one streamed Messages API call per
// round, tool calls answered from the transit services, until the model ends its turn or the
// round cap is hit. Stateless: the client sends the conversation; nothing is stored, and the
// user's location never leaves this process (see assistant.tools.ts).

import { Injectable, Logger } from "@nestjs/common"
import Anthropic from "@anthropic-ai/sdk"
import { InjectConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"
import { AppConfigService } from "@services/app-config/app-config.service"
import type {
	AssistantContext,
	AssistantMessagesBody,
	AssistantStreamEvent,
} from "./assistant.dto"
import { ASSISTANT_TOOLS, AssistantTools } from "./assistant.tools"
import { AnthropicClient } from "./anthropic.client"

type MessageParam = Anthropic.Beta.BetaMessageParam
type ContentBlock = Anthropic.Beta.BetaContentBlock
type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock

const FALLBACK_BETA = "server-side-fallback-2026-07-01"

const SYSTEM_PROMPT = `You are the trip assistant in gezcez, a public transport app for cities in Türkiye. You help riders with routes, stops and departures.

Look things up with the tools instead of guessing: departure times, stop and route ids, and which routes serve a stop all come from them. Find ids with search_transit first when the user names a route or stop. If a tool returns an error or nothing useful, say what you could not find.

The app shows each tool result as a card next to your answer, so summarise the key facts (the next one or two departures, the line to take) rather than repeating every row. Give times as local HH:MM. Live departures (source live or live_eta) come from tracked vehicles; schedule ones are timetable times and may differ.

You cannot plan a door-to-door trip between two places yet; you may point out a route that serves both stops when the tools show it. Answer in the user's language; when unclear, use the app locale given below. Keep answers short: this is a phone screen.`

export type EmitFn = (event: AssistantStreamEvent) => void

@Injectable()
export class AssistantService {
	private readonly logger = new Logger("Assistant")

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly appConfig: AppConfigService,
		private readonly client: AnthropicClient,
		private readonly tools: AssistantTools,
	) {}

	/** ASSISTANT_ENABLED, an API key and the runtime kill switch (all folded into app config). */
	enabled(): boolean {
		return this.appConfig.config({}).kill_switches.assistant === true
	}

	/** Throws FEATURE_DISABLED before any stream is opened. */
	assertEnabled(): void {
		if (!this.enabled()) throw new GezcezError("FEATURE_DISABLED")
	}

	/**
	 * Runs one assistant turn and emits stream events. Never throws: failures become an `error`
	 * event, and an aborted request (client gone) just stops.
	 */
	async respond(body: AssistantMessagesBody, emit: EmitFn, signal?: AbortSignal): Promise<void> {
		const settings = this.config.assistant
		const messages: MessageParam[] = body.messages.map((m) => ({
			role: m.role,
			content: m.content,
		}))
		const usage = { input_tokens: 0, output_tokens: 0 }
		emit({ type: "start", model: settings.model })
		try {
			for (let round = 0; round < settings.maxRounds; round++) {
				const stream = this.client.get().beta.messages.stream(
					{
						model: settings.model,
						max_tokens: settings.maxTokens,
						system: this.system(body.context),
						tools: ASSISTANT_TOOLS,
						messages,
						output_config: { effort: settings.effort },
						...(settings.fallbacks
							? { betas: [FALLBACK_BETA], fallbacks: "default" as const }
							: {}),
					},
					{ signal },
				)
				for await (const event of stream) {
					if (event.type === "content_block_delta" && event.delta.type === "text_delta")
						emit({ type: "text", text: event.delta.text })
				}
				const message = await stream.finalMessage()
				usage.input_tokens += message.usage.input_tokens
				usage.output_tokens += message.usage.output_tokens

				const current = afterLastFallback(message.content)
				const toolUses = current.filter((b): b is ToolUseBlock => b.type === "tool_use")
				// A refusal or a cut-off turn may hold a partial tool call: never run it.
				if (message.stop_reason !== "tool_use" || !toolUses.length) {
					emit({ type: "done", stop_reason: stopReason(message.stop_reason), usage })
					return
				}

				messages.push({ role: "assistant", content: echoable(message.content) })
				const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
				for (const call of toolUses) {
					emit({ type: "tool", id: call.id, name: call.name, status: "running" })
					const outcome = this.tools.run(call.name, call.input, body.context)
					emit({
						type: "tool",
						id: call.id,
						name: call.name,
						status: outcome.isError ? "error" : "done",
					})
					if (outcome.card) emit({ type: "card", card: outcome.card })
					results.push({
						type: "tool_result",
						tool_use_id: call.id,
						content: outcome.content,
						...(outcome.isError ? { is_error: true } : {}),
					})
				}
				// Every result of a turn goes back in one user message.
				messages.push({ role: "user", content: results })
			}
			emit({ type: "done", stop_reason: "max_rounds", usage })
		} catch (error) {
			if (signal?.aborted || error instanceof Anthropic.APIUserAbortError) return
			this.reportFailure(error)
			const fail = new GezcezError("ASSISTANT_UNAVAILABLE")
			emit({ type: "error", code: fail.code, message: fail.message })
		}
	}

	private system(context: AssistantContext): Anthropic.Beta.BetaTextBlockParam[] {
		const lines = [`App locale: ${context.locale}.`]
		if (context.city) lines.push(`The user is browsing city: ${context.city}.`)
		if (context.network) lines.push(`The user is browsing network: ${context.network}.`)
		lines.push(
			context.location
				? "The user shared their location with this message; nearby_stops can use it."
				: "The user has not shared their location.",
		)
		lines.push(`Current time: ${new Date().toISOString()}.`)
		// The fixed prompt comes first so the prefix (tools + prompt) can be cached.
		return [
			{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
			{ type: "text", text: lines.join("\n") },
		]
	}

	/** Logs the failure class and status only: never request bodies, headers or the key. */
	private reportFailure(error: unknown): void {
		if (error instanceof Anthropic.APIError) {
			this.logger.warn(
				{ status: error.status, type: error.constructor.name, request_id: error.requestID },
				"assistant upstream error",
			)
		} else {
			this.logger.error(
				{ type: error instanceof Error ? error.constructor.name : typeof error },
				"assistant failure",
			)
		}
	}
}

/** The blocks produced by the model that finally answered (after the last fallback marker). */
export function afterLastFallback(content: ContentBlock[]): ContentBlock[] {
	const index = content.findLastIndex((b) => b.type === "fallback")
	return index < 0 ? content : content.slice(index + 1)
}

/**
 * The assistant content to send back. Before a mid-output fallback marker only text blocks may
 * be echoed (thinking and tool_use blocks of the declined attempt are dropped).
 */
export function echoable(content: ContentBlock[]): ContentBlock[] {
	const index = content.findLastIndex((b) => b.type === "fallback")
	if (index < 0) return content
	return [
		...content.slice(0, index).filter((b) => b.type === "text"),
		...content.slice(index + 1),
	]
}

function stopReason(
	reason: Anthropic.Beta.BetaStopReason | null,
): Extract<AssistantStreamEvent, { type: "done" }>["stop_reason"] {
	switch (reason) {
		case "end_turn":
		case "max_tokens":
		case "refusal":
			return reason
		case "stop_sequence":
			return "end_turn"
		default:
			return "other"
	}
}
