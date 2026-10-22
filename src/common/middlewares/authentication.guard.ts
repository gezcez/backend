// authentication.guard.ts
// Global guard (plan section 3.2): every route needs a valid bearer access token unless it is
// marked @Public(), @UseDevice() or @UseSession(). @RequireScope() adds scope checks.
// The token check is injected (BEARER_AUTH) so common/ never imports the OAuth module.

import {
	applyDecorators,
	createParamDecorator,
	Inject,
	Injectable,
	SetMetadata,
	type CanActivate,
	type ExecutionContext,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { ApiBearerAuth } from "@nestjs/swagger"
import type { Request } from "express"
import {
	AUTH_KIND_KEY,
	BEARER_AUTH,
	type AuthKind,
	type BearerAuthProvider,
} from "@common/auth.types"
import { GezcezError } from "@common/errors"
import type { RequestAuth } from "@common/jwt.types"

export const REQUIRED_SCOPES_KEY = "gezcez:required-scopes"

@Injectable()
export class AuthenticationGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		@Inject(BEARER_AUTH) private readonly bearer: BearerAuthProvider,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		if (context.getType() !== "http") return true
		const targets = [context.getHandler(), context.getClass()]
		const kind = this.reflector.getAllAndOverride<AuthKind>(AUTH_KIND_KEY, targets) ?? "bearer"
		if (kind !== "bearer") return true

		const req = context.switchToHttp().getRequest<Request>()
		const header = req.headers.authorization
		if (!header) throw new GezcezError("AUTH_REQUIRED")
		const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header)
		if (!match) throw new GezcezError("AUTH_TOKEN_INVALID")
		req.auth = await this.bearer.authenticate(match[1]!)

		const required = this.reflector.getAllAndMerge<string[]>(REQUIRED_SCOPES_KEY, targets)
		const missing = required.filter((scope) => !req.auth!.scopes.includes(scope))
		if (missing.length) throw new GezcezError("SCOPE_MISSING", undefined, { required: missing })
		return true
	}
}

/** The token must carry every listed scope (SCOPE_MISSING with `details.required`). */
export function RequireScope(...scopes: string[]) {
	return applyDecorators(SetMetadata(REQUIRED_SCOPES_KEY, scopes), ApiBearerAuth("bearer"))
}

/** Documents a bearer route that needs no particular scope. */
export function Bearer() {
	return ApiBearerAuth("bearer")
}

export const CurrentAuth = createParamDecorator(
	(_data: unknown, context: ExecutionContext): RequestAuth | undefined =>
		context.switchToHttp().getRequest<Request>().auth,
)
