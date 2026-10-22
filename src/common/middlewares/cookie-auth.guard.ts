// cookie-auth.guard.ts
// Cookie-authenticated routes (/v1/account/*, /v1/oauth/authorize*, /v1/oauth/logout):
//  - @UseDevice(): issues __Host-gz_device if missing and loads the session when there is one
//  - @UseSession(): same, but a live __Host-gz_session is required (AUTH_SESSION_REQUIRED)
//  - @UseSession({ stepUp: true }): the session must have authenticated within STEP_UP_MAX_AGE_S
// Writes need an allowed Origin, Content-Type application/json and X-CSRF-Token (plan 6.1.0).

import {
	applyDecorators,
	createParamDecorator,
	Inject,
	Injectable,
	SetMetadata,
	UseGuards,
	type CanActivate,
	type ExecutionContext,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { ApiCookieAuth, ApiHeader } from "@nestjs/swagger"
import type { Request, Response } from "express"
import {
	AUTH_KIND_KEY,
	COOKIE_AUTH,
	type AuthKind,
	type CookieAuthProvider,
} from "@common/auth.types"
import { InjectConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"
import { safeEqual } from "@common/utils"

const STEP_UP_KEY = "gezcez:session-step-up"
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

export const CSRF_HEADER = "x-csrf-token"

export function allowedOrigins(config: AppConfig): Set<string> {
	return new Set(
		[config.oauthUiUrl, ...config.corsOrigins].map((origin) => origin.replace(/\/$/, "")),
	)
}

@Injectable()
export class CookieAuthGuard implements CanActivate {
	private readonly origins: Set<string>

	constructor(
		private readonly reflector: Reflector,
		@Inject(COOKIE_AUTH) private readonly cookies: CookieAuthProvider,
		@InjectConfig() private readonly config: AppConfig,
	) {
		this.origins = allowedOrigins(config)
	}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const targets = [context.getHandler(), context.getClass()]
		const kind = this.reflector.getAllAndOverride<AuthKind>(AUTH_KIND_KEY, targets)
		const stepUp = this.reflector.getAllAndOverride<boolean>(STEP_UP_KEY, targets) ?? false
		const http = context.switchToHttp()
		const req = http.getRequest<Request>()
		const res = http.getResponse<Response>()

		if (!SAFE_METHODS.has(req.method)) this.checkOrigin(req)

		const device = this.cookies.ensureDevice(req, res)
		req.device = device
		const session = await this.cookies.resolveSession(req, device)
		if (session) req.session = session

		if (!SAFE_METHODS.has(req.method)) this.checkCsrf(req)

		if (kind === "session" && !session) throw new GezcezError("AUTH_SESSION_REQUIRED")
		if (stepUp && session) {
			const ageS = (Date.now() - session.authTime.getTime()) / 1000
			if (ageS > this.config.stepUpMaxAgeS) {
				throw new GezcezError("AUTH_STEP_UP_REQUIRED", undefined, {
					max_age: this.config.stepUpMaxAgeS,
				})
			}
		}
		return true
	}

	private checkOrigin(req: Request): void {
		const origin = req.headers.origin
		if (!origin || !this.origins.has(origin.replace(/\/$/, ""))) {
			throw new GezcezError("CSRF_INVALID", "Origin is not allowed")
		}
		const length = Number(req.headers["content-length"] ?? 0)
		const hasBody = length > 0 || req.headers["transfer-encoding"] !== undefined
		if (hasBody && !(req.headers["content-type"] ?? "").startsWith("application/json")) {
			throw new GezcezError("CSRF_INVALID", "Content-Type must be application/json")
		}
	}

	private checkCsrf(req: Request): void {
		const header = req.headers[CSRF_HEADER]
		const token = Array.isArray(header) ? header[0] : header
		const expected = this.cookies.csrfTokens(req.device!, req.session ?? null)
		if (!token || !expected.some((candidate) => safeEqual(candidate, token))) {
			throw new GezcezError("CSRF_INVALID", "Missing or invalid X-CSRF-Token")
		}
	}
}

function csrfDocs() {
	return ApiHeader({
		name: "X-CSRF-Token",
		required: false,
		description: "Required on writes; from GET /v1/account/csrf",
	})
}

/** Device cookie route: works before sign-in, loads the session when present. */
export function UseDevice() {
	return applyDecorators(
		SetMetadata(AUTH_KIND_KEY, "device"),
		UseGuards(CookieAuthGuard),
		csrfDocs(),
	)
}

/** Session cookie route. `stepUp` requires a recent authentication (AUTH_STEP_UP_REQUIRED). */
export function UseSession(options: { stepUp?: boolean } = {}) {
	return applyDecorators(
		SetMetadata(AUTH_KIND_KEY, "session"),
		SetMetadata(STEP_UP_KEY, options.stepUp ?? false),
		UseGuards(CookieAuthGuard),
		ApiCookieAuth("session"),
		csrfDocs(),
	)
}

export const CurrentDevice = createParamDecorator((_data: unknown, context: ExecutionContext) => {
	return context.switchToHttp().getRequest<Request>().device
})

export const CurrentSession = createParamDecorator((_data: unknown, context: ExecutionContext) => {
	return context.switchToHttp().getRequest<Request>().session
})
