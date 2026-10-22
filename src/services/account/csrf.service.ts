// csrf.service.ts
// Synchronizer tokens for cookie-authenticated writes: HMAC of the session id, or of the device
// before sign-in. Both stay valid, so signing in does not invalidate the token the UI holds.

import { Injectable } from "@nestjs/common"
import type { DeviceContext, SessionContext } from "@common/auth.types"
import { InjectConfig, type AppConfig } from "@common/config"
import { hmacBase64Url } from "@common/utils"

@Injectable()
export class CsrfService {
	constructor(@InjectConfig() private readonly config: AppConfig) {}

	tokenFor(device: DeviceContext, session: SessionContext | null): string {
		return session ? this.sessionToken(session.id) : this.deviceToken(device.hash)
	}

	acceptedTokens(device: DeviceContext, session: SessionContext | null): string[] {
		const tokens = [this.deviceToken(device.hash)]
		if (session) tokens.push(this.sessionToken(session.id))
		return tokens
	}

	private sessionToken(sessionId: string): string {
		return hmacBase64Url(this.config.secrets.csrf, `csrf:s:${sessionId}`)
	}

	private deviceToken(deviceHash: string): string {
		return hmacBase64Url(this.config.secrets.csrf, `csrf:d:${deviceHash}`)
	}
}
