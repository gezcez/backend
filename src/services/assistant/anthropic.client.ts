// anthropic.client.ts
// Owns the Anthropic SDK client for the assistant. The API key comes from ANTHROPIC_API_KEY via
// the config and is handed to the SDK only; it is never logged, returned or stored. Tests swap
// the client with `use()` so no request ever leaves the process.

import { Injectable } from "@nestjs/common"
import Anthropic from "@anthropic-ai/sdk"
import { InjectConfig, type AppConfig } from "@common/config"

/** The part of the SDK the assistant calls (what tests fake). */
export type AssistantLlm = Pick<Anthropic, "beta">

@Injectable()
export class AnthropicClient {
	private client: AssistantLlm | null = null

	constructor(@InjectConfig() private readonly config: AppConfig) {}

	get(): AssistantLlm {
		this.client ??= new Anthropic({
			apiKey: this.config.assistant.apiKey,
			timeout: this.config.assistant.timeoutMs,
			maxRetries: 2,
			// The SDK logs nothing below "warn" and never the key; keep it quiet anyway.
			logLevel: "off",
		})
		return this.client
	}

	/** Replaces the SDK client (tests). */
	use(client: AssistantLlm): void {
		this.client = client
	}
}
