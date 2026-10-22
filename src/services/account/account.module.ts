// account.module.ts
// Global: the cookie guard (COOKIE_AUTH) and the session service are used by the OAuth module.

import { Global, Module } from "@nestjs/common"
import { COOKIE_AUTH } from "@common/auth.types"
import { AccountController } from "./account.controller"
import { AccountRepository } from "./account.repository"
import { AccountService } from "./account.service"
import { BreachedPasswordService } from "./breached-password.service"
import { AccountCookieAuth } from "./cookie-auth.provider"
import { CsrfService } from "./csrf.service"
import { DeviceService } from "./device.service"
import { PasskeyController } from "./passkey.controller"
import { PasskeyRepository } from "./passkey.repository"
import { PasskeyService } from "./passkey.service"
import { PasswordController } from "./password.controller"
import { PasswordService } from "./password.service"
import { RevokedSessionsService } from "./revoked-sessions.service"
import { SelfServiceController } from "./self-service.controller"
import { SelfServiceRepository } from "./self-service.repository"
import { SelfServiceService } from "./self-service.service"
import { SessionRepository } from "./session.repository"
import { SessionService } from "./session.service"
import { TurnstileService } from "./turnstile.service"

@Global()
@Module({
	controllers: [AccountController, PasswordController, PasskeyController, SelfServiceController],
	providers: [
		AccountService,
		AccountRepository,
		PasswordService,
		PasskeyService,
		PasskeyRepository,
		SelfServiceService,
		SelfServiceRepository,
		BreachedPasswordService,
		SessionService,
		SessionRepository,
		RevokedSessionsService,
		DeviceService,
		CsrfService,
		TurnstileService,
		AccountCookieAuth,
		{ provide: COOKIE_AUTH, useExisting: AccountCookieAuth },
	],
	exports: [
		AccountService,
		SessionService,
		RevokedSessionsService,
		DeviceService,
		CsrfService,
		TurnstileService,
		COOKIE_AUTH,
	],
})
export class AccountModule {}
