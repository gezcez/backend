// clients.service.ts
// OAuth client lookup, display info and client authentication at the token endpoint.

import { Injectable } from "@nestjs/common"
import type { Request } from "express"
import { GezcezError, OAuthProtocolError } from "@common/errors"
import { SCOPES, isScope } from "@common/scopes"
import { safeEqual, sha256Hex } from "@common/utils"
import type { AppInfoDto, ClientInfoDto } from "./oauth.dto"
import { OAuthRepository, type AppRow } from "./oauth.repository"
import { parseBasicAuth } from "./oauth.utils"

export interface ScopeInfo {
	key: string
	i18n_key: string
}

export function scopeInfo(scopes: string[]): ScopeInfo[] {
	return scopes.filter(isScope).map((key) => ({ key, i18n_key: SCOPES[key].i18n_key }))
}

@Injectable()
export class ClientsService {
	constructor(private readonly repository: OAuthRepository) {}

	/** An enabled client, or undefined. */
	findActive(clientId: string | undefined): AppRow | undefined {
		if (!clientId || clientId.length > 128) return undefined
		const app = this.repository.findApp(clientId)
		return app?.status === "active" ? app : undefined
	}

	info(app: AppRow): ClientInfoDto {
		return {
			client_id: app.client_id,
			name: app.name,
			...(app.logo_url ? { logo_url: app.logo_url } : {}),
			...(app.homepage_url ? { homepage_url: app.homepage_url } : {}),
			first_party: app.first_party,
			type: app.type,
		}
	}

	publicInfo(clientId: string): AppInfoDto {
		const app = this.findActive(clientId)
		if (!app) throw new GezcezError("NOT_FOUND", "Unknown client")
		return { ...this.info(app), scopes: scopeInfo(app.allowed_scopes) }
	}

	/**
	 * Client authentication (RFC 6749 section 2.3): client_secret_basic or client_secret_post for
	 * confidential clients, client_id alone for public ones. `fallbackClientId` is the client a
	 * gz_rt cookie belongs to, for cookie refreshes with an empty body.
	 */
	authenticate(req: Request, body: Record<string, unknown>, fallbackClientId?: string): AppRow {
		const basic = parseBasicAuth(req.headers.authorization)
		const bodyId = typeof body.client_id === "string" ? body.client_id : undefined
		const bodySecret = typeof body.client_secret === "string" ? body.client_secret : undefined
		if (basic && bodySecret !== undefined)
			throw new OAuthProtocolError("invalid_request", "Use one client authentication method")
		if (basic && bodyId !== undefined && bodyId !== basic.clientId)
			throw new OAuthProtocolError("invalid_client")
		const clientId = basic?.clientId ?? bodyId ?? fallbackClientId
		const secret = basic?.secret ?? bodySecret
		if (!clientId) throw new OAuthProtocolError("invalid_client", "client_id is required")
		const app = this.findActive(clientId)
		if (!app) throw new OAuthProtocolError("invalid_client")
		if (app.type === "confidential") {
			if (!secret || !this.secretMatches(app, secret))
				throw new OAuthProtocolError("invalid_client")
		} else if (secret !== undefined) {
			throw new OAuthProtocolError("invalid_client", "Public clients have no secret")
		}
		return app
	}

	/** Checks the current secret, then the previous one inside its grace; records the use. */
	private secretMatches(app: AppRow, secret: string): boolean {
		const hash = sha256Hex(secret)
		if (app.client_secret_hash && safeEqual(app.client_secret_hash, hash)) {
			this.repository.markSecretUsed(app.client_id, "current", new Date())
			return true
		}
		const previous =
			app.previous_secret_hash !== null &&
			app.previous_secret_expires_at !== null &&
			app.previous_secret_expires_at > new Date() &&
			safeEqual(app.previous_secret_hash, hash)
		if (previous) this.repository.markSecretUsed(app.client_id, "previous", new Date())
		return previous
	}
}
