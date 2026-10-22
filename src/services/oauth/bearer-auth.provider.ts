// bearer-auth.provider.ts
// Implements the BearerAuthProvider the global AuthenticationGuard depends on: signature, issuer
// and expiry through KeysService, then the revoked sid set and the user's status.

import { Injectable } from "@nestjs/common"
import type { BearerAuthProvider } from "@common/auth.types"
import { GezcezError } from "@common/errors"
import type { RequestAuth } from "@common/jwt.types"
import { parseScope } from "@common/scopes"
import { RevokedSessionsService } from "@services/account/revoked-sessions.service"
import { KeysService } from "./keys.service"
import { OAuthRepository } from "./oauth.repository"

@Injectable()
export class OAuthBearerAuth implements BearerAuthProvider {
	constructor(
		private readonly keys: KeysService,
		private readonly revoked: RevokedSessionsService,
		private readonly repository: OAuthRepository,
	) {}

	async authenticate(token: string): Promise<RequestAuth> {
		const claims = await this.keys.verify(token)
		if (this.revoked.has(claims.sid)) throw new GezcezError("AUTH_SESSION_REVOKED")
		const user = this.repository.findUserByPublicId(claims.sub)
		if (!user || (user.status !== "active" && user.status !== "pending_deletion"))
			throw new GezcezError("AUTH_SESSION_REVOKED")
		// Audience: the token's client must still exist and be enabled, and only first-party
		// clients carry `dash` (staff API), whatever the token says.
		const app = this.repository.findApp(claims.aud)
		if (!app || app.status !== "active") throw new GezcezError("AUTH_SESSION_REVOKED")
		const scopes = parseScope(claims.scope).filter(
			(scope) => scope !== "dash" || app.first_party,
		)
		return {
			userId: user.id,
			publicId: user.public_id,
			clientId: claims.aud,
			scopes,
			sid: claims.sid,
			authTime: claims.auth_time,
			amr: claims.amr ?? [],
			exp: claims.exp,
		}
	}
}
