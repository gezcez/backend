// apps.service.ts
// OAuth client administration (plan 6.2): create (secret shown once for confidential clients),
// edit (redirect URIs and the first-party flag also need a fresh sign-in), rotate the secret with
// a grace period for the previous one, revoke every refresh family, and delete (never system
// apps).

import { Injectable } from "@nestjs/common"
import type { Request } from "express"
import { InjectConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"
import { assertStepUp } from "@common/middlewares"
import type { Page } from "@common/response"
import { isScope } from "@common/scopes"
import { randomToken, sha256Hex } from "@common/utils"
import type { AppRow } from "@schemas/core"
import { AuditService } from "@services/audit/audit.service"
import type {
	AppDetailData,
	AppQueryDto,
	CreateAppDto,
	RotateSecretDto,
	UpdateAppDto,
} from "./apps.dto"
import { AppsRepository } from "./apps.repository"
import { redirectUriProblems } from "./redirect-uris"

const DAY_S = 86_400
const GRACE_MS = { none: 0, "24h": DAY_S * 1000, "7d": 7 * DAY_S * 1000 } as const
const SECRET_PREFIX_LENGTH = 8

type AppListItem = {
	client_id: string
	name: string
	type: AppRow["type"]
	platform: AppRow["platform"]
	first_party: boolean
	system: boolean
	redirect_uri_count: number
	active_families: number
	tokens_24h: number
	created_at: string
}

function newSecret(): string {
	return `gzs_${randomToken(32)}`
}

function slug(name: string): string {
	return (
		name
			.toLowerCase()
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/ı/g, "i")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 40) || "app"
	)
}

@Injectable()
export class AppsService {
	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly repository: AppsRepository,
		private readonly audit: AuditService,
	) {}

	list(query: AppQueryDto): Page<AppListItem> {
		const page = this.repository.page(query)
		const ids = page.items.map((app) => app.client_id)
		const families = this.repository.activeFamilies(ids, new Date())
		const tokens = this.tokensSince(ids, new Date(Date.now() - DAY_S * 1000))
		return {
			...page,
			items: page.items.map((app) => ({
				client_id: app.client_id,
				name: app.name,
				type: app.type,
				platform: app.platform,
				first_party: app.first_party,
				system: app.system,
				redirect_uri_count: app.redirect_uris.length,
				active_families: families.get(app.client_id) ?? 0,
				tokens_24h: tokens.get(app.client_id) ?? 0,
				created_at: app.created_at.toISOString(),
			})),
		}
	}

	detail(clientId: string): AppDetailData {
		return this.present(this.find(clientId))
	}

	create(req: Request, body: CreateAppDto): { app: AppDetailData; secret: string | null } {
		this.checkRedirectUris(body.redirect_uris, body.platform)
		const base = slug(body.name)
		let clientId = base
		for (let i = 0; this.repository.find(clientId); i++)
			clientId = `${base}-${randomToken(3)
				.toLowerCase()
				.replace(/[^a-z0-9]/g, "")}${i}`
		const now = new Date()
		const secret = body.type === "confidential" ? newSecret() : null
		const row = this.repository.insert({
			client_id: clientId,
			name: body.name,
			description: body.description,
			type: body.type,
			platform: body.platform,
			dev: body.platform === "dev",
			homepage_url: body.homepage_url,
			redirect_uris: body.redirect_uris,
			post_logout_redirect_uris: [],
			allowed_scopes: ["openid", "profile"],
			refresh_ttl_s: body.platform === "native" ? 90 * DAY_S : 30 * DAY_S,
			refresh_max_s: 180 * DAY_S,
			...(secret
				? {
						client_secret_hash: sha256Hex(secret),
						secret_prefix: secret.slice(0, SECRET_PREFIX_LENGTH),
						secret_created_at: now,
					}
				: {}),
			created_by: req.auth!.userId,
			created_at: now,
		})
		this.audit.record("apps.created", {
			req,
			target: { type: "app", id: clientId },
			data: { after: { name: row.name, type: row.type, platform: row.platform } },
		})
		return { app: this.present(row), secret }
	}

	update(req: Request, clientId: string, body: UpdateAppDto): AppDetailData {
		const app = this.find(clientId)
		if (body.redirect_uris !== undefined || body.first_party !== undefined)
			assertStepUp(req, this.config)
		if (body.redirect_uris) this.checkRedirectUris(body.redirect_uris, app.platform)
		if (body.scopes) {
			const unknown = body.scopes.filter((scope) => !isScope(scope))
			if (unknown.length)
				throw new GezcezError("VALIDATION_FAILED", "Unknown scopes", {
					fields: { scopes: unknown.join(", ") },
				})
		}
		const refreshTtl = body.refresh_ttl_s ?? app.refresh_ttl_s
		const refreshMax = body.refresh_max_s ?? app.refresh_max_s
		if (refreshMax < refreshTtl)
			throw new GezcezError(
				"VALIDATION_FAILED",
				"refresh_max_s must be at least refresh_ttl_s",
				{
					fields: { refresh_max_s: "below refresh_ttl_s" },
				},
			)
		const { scopes, ...rest } = body
		const patch = { ...rest, ...(scopes ? { allowed_scopes: [...new Set(scopes)] } : {}) }
		const before = Object.fromEntries(
			Object.keys(patch).map((key) => [key, app[key as keyof AppRow]]),
		)
		const updated = this.repository.update(clientId, {
			...patch,
			updated_by: req.auth!.userId,
			updated_at: new Date(),
		})
		this.audit.record("apps.updated", {
			req,
			target: { type: "app", id: clientId },
			data: { before, after: patch },
		})
		return this.present(updated)
	}

	/** New secret, shown once; the old one keeps working for the chosen grace. */
	rotateSecret(req: Request, clientId: string, body: RotateSecretDto) {
		const app = this.find(clientId)
		if (app.type !== "confidential")
			throw new GezcezError("CONFLICT", "Public clients have no secret")
		const now = new Date()
		const secret = newSecret()
		const grace = GRACE_MS[body.grace]
		const keepPrevious = grace > 0 && app.client_secret_hash !== null
		const updated = this.repository.update(clientId, {
			client_secret_hash: sha256Hex(secret),
			secret_prefix: secret.slice(0, SECRET_PREFIX_LENGTH),
			secret_created_at: now,
			secret_last_used_at: null,
			previous_secret_hash: keepPrevious ? app.client_secret_hash : null,
			previous_secret_prefix: keepPrevious ? app.secret_prefix : null,
			previous_secret_created_at: keepPrevious ? app.secret_created_at : null,
			previous_secret_last_used_at: keepPrevious ? app.secret_last_used_at : null,
			previous_secret_expires_at: keepPrevious ? new Date(now.getTime() + grace) : null,
			updated_by: req.auth!.userId,
			updated_at: now,
		})
		this.audit.record("apps.secret_rotated", {
			req,
			target: { type: "app", id: clientId },
			data: { after: { grace: body.grace, prefix: updated.secret_prefix } },
		})
		return { secret, meta: this.secrets(updated)[0]! }
	}

	revokePreviousSecret(req: Request, clientId: string): { revoked: boolean } {
		const app = this.find(clientId)
		const live =
			app.previous_secret_hash !== null &&
			app.previous_secret_expires_at !== null &&
			app.previous_secret_expires_at > new Date()
		this.repository.update(clientId, {
			previous_secret_hash: null,
			previous_secret_prefix: null,
			previous_secret_created_at: null,
			previous_secret_last_used_at: null,
			previous_secret_expires_at: null,
			updated_by: req.auth!.userId,
			updated_at: new Date(),
		})
		if (live)
			this.audit.record("apps.secret_revoked", { req, target: { type: "app", id: clientId } })
		return { revoked: live }
	}

	revokeAll(req: Request, clientId: string, reason: string): { revoked: number } {
		this.find(clientId)
		const revoked = this.repository.revokeAll(clientId, new Date())
		this.audit.record("apps.revoke_all", {
			req,
			target: { type: "app", id: clientId },
			data: { reason, families: revoked },
		})
		return { revoked }
	}

	delete(req: Request, clientId: string): { deleted: boolean } {
		const app = this.find(clientId)
		if (app.system) throw new GezcezError("CONFLICT", "System apps cannot be deleted")
		this.repository.delete(clientId)
		this.audit.record("apps.deleted", {
			req,
			target: { type: "app", id: clientId },
			data: { before: { name: app.name, type: app.type } },
		})
		return { deleted: true }
	}

	private present(app: AppRow): AppDetailData {
		const now = new Date()
		const usage = this.usage([app.client_id], new Date(now.getTime() - 30 * DAY_S * 1000))
		const days = [...usage.entries()]
			.filter(([key]) => key.startsWith(`${app.client_id}|`))
			.map(([key, tokens]) => ({ date: key.split("|")[1]!, tokens }))
			.sort((a, b) => a.date.localeCompare(b.date))
		return {
			client_id: app.client_id,
			name: app.name,
			description: app.description,
			logo_url: app.logo_url,
			homepage_url: app.homepage_url,
			type: app.type,
			platform: app.platform,
			first_party: app.first_party,
			system: app.system,
			redirect_uris: app.redirect_uris,
			scopes: app.allowed_scopes,
			access_ttl_s: app.access_ttl_s,
			refresh_ttl_s: app.refresh_ttl_s,
			refresh_max_s: app.refresh_max_s,
			secrets: this.secrets(app),
			active_families:
				this.repository.activeFamilies([app.client_id], now).get(app.client_id) ?? 0,
			tokens_24h:
				this.tokensSince([app.client_id], new Date(now.getTime() - DAY_S * 1000)).get(
					app.client_id,
				) ?? 0,
			usage: days,
			created_at: app.created_at.toISOString(),
			updated_at: (app.updated_at ?? app.created_at).toISOString(),
		}
	}

	private secrets(app: AppRow): AppDetailData["secrets"] {
		const secrets: AppDetailData["secrets"] = []
		if (app.client_secret_hash)
			secrets.push({
				id: "current",
				prefix: app.secret_prefix ?? "",
				state: "current",
				created_at: (app.secret_created_at ?? app.created_at).toISOString(),
				last_used_at: app.secret_last_used_at?.toISOString() ?? null,
				expires_at: null,
			})
		if (
			app.previous_secret_hash &&
			app.previous_secret_expires_at &&
			app.previous_secret_expires_at > new Date()
		)
			secrets.push({
				id: "previous",
				prefix: app.previous_secret_prefix ?? "",
				state: "previous",
				created_at: (app.previous_secret_created_at ?? app.created_at).toISOString(),
				last_used_at: app.previous_secret_last_used_at?.toISOString() ?? null,
				expires_at: app.previous_secret_expires_at.toISOString(),
			})
		return secrets
	}

	/** client_id|YYYY-MM-DD to tokens. */
	private usage(clientIds: string[], since: Date): Map<string, number> {
		const map = new Map<string, number>()
		for (const row of this.repository.usage(clientIds, since)) {
			const key = `${row.client_id}|${row.day}`
			map.set(key, (map.get(key) ?? 0) + row.n)
		}
		return map
	}

	private tokensSince(clientIds: string[], since: Date): Map<string, number> {
		const totals = new Map<string, number>()
		for (const row of this.repository.usage(clientIds, since))
			totals.set(row.client_id, (totals.get(row.client_id) ?? 0) + row.n)
		return totals
	}

	private find(clientId: string): AppRow {
		const app = this.repository.find(clientId)
		if (!app) throw new GezcezError("NOT_FOUND", "App not found")
		return app
	}

	private checkRedirectUris(uris: string[], platform: AppRow["platform"]): void {
		const problems = redirectUriProblems(uris, platform)
		if (problems.length)
			throw new GezcezError("VALIDATION_FAILED", "Invalid redirect URIs", {
				fields: { redirect_uris: problems.join("; ") },
			})
	}
}
