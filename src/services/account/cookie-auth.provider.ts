// cookie-auth.provider.ts
// Implements the CookieAuthProvider the common CookieAuthGuard depends on.

import { Injectable } from "@nestjs/common"
import type { Request, Response } from "express"
import type { CookieAuthProvider, DeviceContext, SessionContext } from "@common/auth.types"
import { CsrfService } from "./csrf.service"
import { DeviceService } from "./device.service"
import { SessionService } from "./session.service"

@Injectable()
export class AccountCookieAuth implements CookieAuthProvider {
	constructor(
		private readonly devices: DeviceService,
		private readonly sessions: SessionService,
		private readonly csrf: CsrfService,
	) {}

	ensureDevice(req: Request, res: Response): DeviceContext {
		return this.devices.ensure(req, res)
	}

	async resolveSession(req: Request, device: DeviceContext): Promise<SessionContext | null> {
		return this.sessions.resolve(req, device)
	}

	csrfTokens(device: DeviceContext, session: SessionContext | null): string[] {
		return this.csrf.acceptedTokens(device, session)
	}
}
