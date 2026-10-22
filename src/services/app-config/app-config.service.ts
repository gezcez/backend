// app-config.service.ts
// GET /v1/app/config (plan 8.2): force and soft update versions, feature flags, kill switches,
// an announcement banner, tile style URLs and the WS URL. Values come from `app.*` flags with
// code defaults; each version flag may be one string or one per platform.
//
//   app.min_supported_version  "1.0.0" | { ios: "1.0.0", android: "1.0.1" }
//   app.soft_update_version    same, or null
//   app.features               { "<flag>": boolean }
//   app.kill_switches          { cards, live_map, assistant: boolean } (false turns a feature off)
//
// `kill_switches.assistant` is also false unless ASSISTANT_ENABLED and ANTHROPIC_API_KEY are set,
// so the app shows the assistant entry only when the endpoint will accept requests.
//   app.announcement           { id, level, title: {tr,en}, body: {tr,en}, url } | null

import { Injectable, Logger } from "@nestjs/common"
import { InjectConfig, type AppConfig } from "@common/config"
import type { AppConfigDto, AppConfigQueryDto } from "./app-config.dto"
import { AnnouncementSchema } from "./app-config.dto"
import { AppConfigRepository } from "./app-config.repository"

const CACHE_MS = 15_000
const DEFAULT_KILL_SWITCHES = { cards: true, live_map: true }

type Platform = "ios" | "android"

/** Compares dotted numeric versions; pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) =>
		v
			.split(/[-+]/)[0]!
			.split(".")
			.map((n) => Number(n) || 0)
	const x = parse(a)
	const y = parse(b)
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0)
		if (d) return Math.sign(d)
	}
	return 0
}

function versionFor(value: unknown, platform: Platform | undefined): string | null {
	if (typeof value === "string") return value
	if (value && typeof value === "object" && platform) {
		const v = (value as Record<string, unknown>)[platform]
		if (typeof v === "string") return v
	}
	return null
}

function booleans(value: unknown): Record<string, boolean> {
	if (!value || typeof value !== "object") return {}
	return Object.fromEntries(
		Object.entries(value).filter((e): e is [string, boolean] => typeof e[1] === "boolean"),
	)
}

@Injectable()
export class AppConfigService {
	private readonly logger = new Logger("AppConfig")
	private cached: { at: number; flags: Map<string, unknown> } | null = null

	constructor(
		private readonly repository: AppConfigRepository,
		@InjectConfig() private readonly env: AppConfig,
	) {}

	/** Drops the cache after a flag write. */
	invalidate(): void {
		this.cached = null
	}

	private flags(): Map<string, unknown> {
		const now = Date.now()
		if (!this.cached || now - this.cached.at > CACHE_MS)
			this.cached = { at: now, flags: this.repository.appFlags() }
		return this.cached.flags
	}

	config(query: AppConfigQueryDto): AppConfigDto {
		const flags = this.flags()
		const min = versionFor(flags.get("app.min_supported_version"), query.platform) ?? "0.0.0"
		const soft = versionFor(flags.get("app.soft_update_version"), query.platform)
		let update: AppConfigDto["update"] = "none"
		if (query.version) {
			if (compareVersions(query.version, min) < 0) update = "force"
			else if (soft && compareVersions(query.version, soft) < 0) update = "soft"
		}
		let announcement: AppConfigDto["announcement"] = null
		const raw = flags.get("app.announcement")
		if (raw) {
			const parsed = AnnouncementSchema.safeParse(raw)
			if (parsed.success) announcement = parsed.data
			else this.logger.warn("app.announcement flag is malformed; ignored")
		}
		const kills = booleans(flags.get("app.kill_switches"))
		const assistantEnv = this.env.assistant.enabled && Boolean(this.env.assistant.apiKey)
		return {
			min_supported_version: min,
			soft_update_version: soft,
			update,
			flags: booleans(flags.get("app.features")),
			kill_switches: {
				...DEFAULT_KILL_SWITCHES,
				...kills,
				assistant: assistantEnv && kills.assistant !== false,
			},
			announcement,
			tiles_style_url: this.env.tilesStyleUrl,
			ws_url: `${this.env.publicApiUrl.replace(/^http/, "ws")}/v1/ws`,
		}
	}
}
