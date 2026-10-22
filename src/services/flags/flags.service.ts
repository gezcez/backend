// flags.service.ts
// Flags and settings (plan 6.16): definitions in code, overrides in core.db behind an
// in-memory cache that every write refreshes. Readers get typed values with the default
// filled in; a stored value that no longer matches its schema falls back to the default.

import { Injectable, Logger } from "@nestjs/common"
import type { Request } from "express"
import { InjectConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"
import { assertStepUp } from "@common/middlewares"
import type { FlagRow } from "@schemas/core"
import { AuditService } from "@services/audit/audit.service"
import { RefsService } from "@services/refs/refs.service"
import {
	FLAG_DEFINITIONS,
	FLAG_KEYS,
	isFlagKey,
	SETTINGS_GROUPS,
	type FlagKey,
	type FlagValue,
	type SettingsGroup,
} from "./flag-definitions"
import type { Flag, FlagDetail, Settings, SettingsPatch } from "./flags.dto"
import { FlagsRepository } from "./flags.repository"

const HISTORY_LIMIT = 20
/** Writes refresh at once; the TTL only covers rows written outside this service. */
const CACHE_MS = 15_000
const FLAG_ACTIONS = ["flags.updated", "flags.critical_updated", "settings.updated"]

@Injectable()
export class FlagsService {
	private readonly logger = new Logger("Flags")
	private rows: { at: number; map: Map<string, FlagRow> } | null = null
	private readonly listeners = new Set<(key: FlagKey) => void>()

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly repository: FlagsRepository,
		private readonly refs: RefsService,
		private readonly audit: AuditService,
	) {}

	/** Called after every write (for caches such as /v1/app/config). */
	onChange(listener: (key: FlagKey) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	get<K extends FlagKey>(key: K): FlagValue<K> {
		const row = this.cache().get(key)
		if (!row) return FLAG_DEFINITIONS[key].default
		const parsed = FLAG_DEFINITIONS[key].schema.safeParse(row.value)
		if (parsed.success) return parsed.data as FlagValue<K>
		this.logger.warn(`Stored value of ${key} does not match its schema; using the default`)
		return FLAG_DEFINITIONS[key].default
	}

	list(): Flag[] {
		return FLAG_KEYS.filter((key) => !key.startsWith("settings.")).map((key) =>
			this.present(key),
		)
	}

	detail(key: string): FlagDetail {
		const flag = this.flagKey(key)
		const rows = this.repository.history(flag, FLAG_ACTIONS, HISTORY_LIMIT)
		const users = this.refs.users(rows.map((row) => row.actor_user_id))
		return {
			...this.present(flag),
			history: rows.map((row) => {
				const data = (row.data ?? {}) as { before?: unknown; after?: unknown }
				return {
					at: row.at.toISOString(),
					by: row.actor_user_id === null ? null : (users.get(row.actor_user_id) ?? null),
					before: data.before ?? null,
					after: data.after ?? null,
				}
			}),
		}
	}

	/** PUT /v1/dash/flags/:key. `value: null` on a non-nullable flag is refused by its schema. */
	set(req: Request, key: string, body: { value?: unknown; reset?: boolean }): Flag {
		const flag = this.flagKey(key)
		if (flag.startsWith("settings."))
			throw new GezcezError("VALIDATION_FAILED", "Settings are edited on /v1/dash/settings")
		const definition = FLAG_DEFINITIONS[flag]
		if (definition.critical) assertStepUp(req, this.config)
		const before = this.get(flag)
		if (body.reset) {
			this.repository.remove(flag)
		} else {
			if (!("value" in body))
				throw new GezcezError("VALIDATION_FAILED", "value or reset is required")
			const parsed = definition.schema.safeParse(body.value)
			if (!parsed.success)
				throw new GezcezError("VALIDATION_FAILED", "Value does not match the flag", {
					issues: parsed.error.issues.map((issue) => ({
						path: issue.path.join("."),
						message: issue.message,
					})),
				})
			this.repository.upsert(flag, parsed.data, req.auth!.userId, new Date())
		}
		this.changed(flag)
		this.audit.record(definition.critical ? "flags.critical_updated" : "flags.updated", {
			req,
			target: { type: "flag", id: flag },
			data: { before, after: this.get(flag), ...(body.reset ? { reset: true } : {}) },
		})
		return this.present(flag)
	}

	settings(): Settings {
		return {
			signup: this.get("settings.signup"),
			maintenance: this.get("settings.maintenance"),
		}
	}

	/** PATCH /v1/dash/settings (+sudo): each group given is replaced whole. */
	updateSettings(req: Request, patch: SettingsPatch): Settings {
		const now = new Date()
		for (const group of SETTINGS_GROUPS) {
			const value = patch[group]
			if (value === undefined) continue
			const key = `settings.${group}` as const satisfies `settings.${SettingsGroup}`
			const before = this.get(key)
			this.repository.upsert(key, value, req.auth!.userId, now)
			this.changed(key)
			this.audit.record("settings.updated", {
				req,
				target: { type: "flag", id: key },
				data: { before, after: value },
			})
		}
		return this.settings()
	}

	private present(key: FlagKey): Flag {
		const row = this.cache().get(key)
		const definition = FLAG_DEFINITIONS[key]
		return {
			key,
			description: definition.description,
			critical: definition.critical,
			value: this.get(key),
			default: definition.default,
			is_default: !row,
			updated_at: row?.updated_at.toISOString() ?? null,
			updated_by: row?.updated_by
				? (this.refs.users([row.updated_by]).get(row.updated_by) ?? null)
				: null,
		}
	}

	private flagKey(key: string): FlagKey {
		if (!isFlagKey(key)) throw new GezcezError("NOT_FOUND", "Unknown flag")
		return key
	}

	private cache(): Map<string, FlagRow> {
		const now = Date.now()
		if (!this.rows || now - this.rows.at > CACHE_MS)
			this.rows = {
				at: now,
				map: new Map(this.repository.all().map((row) => [row.key, row])),
			}
		return this.rows.map
	}

	private changed(key: FlagKey): void {
		this.rows = null
		for (const listener of this.listeners) {
			try {
				listener(key)
			} catch (error) {
				this.logger.error(`Flag listener failed: ${(error as Error).message}`)
			}
		}
	}
}
