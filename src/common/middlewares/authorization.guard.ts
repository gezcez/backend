// authorization.guard.ts
// @UseAuthorization({ permission, scope, sudo?, description }) (plan section 6.4):
//  - needs a bearer token with the `dash` scope (checked by the global AuthenticationGuard)
//  - AuthorizationGuard checks the permission globally or in the route's :networkId
//  - sudo adds StepUpGuard: auth_time within STEP_UP_MAX_AGE_S, else AUTH_STEP_UP_REQUIRED
//  - documents x-gezcez-permission and x-gezcez-sudo on the OpenAPI operation
// The registry in the roles module scans this metadata at boot.

import {
	applyDecorators,
	Inject,
	Injectable,
	SetMetadata,
	UseGuards,
	type CanActivate,
	type ExecutionContext,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { ApiBearerAuth, ApiExtension } from "@nestjs/swagger"
import type { Request } from "express"
import { hasPermission, PERMISSION_RESOLVER, type PermissionResolver } from "@common/authorization"
import { InjectConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"
import type { PermissionKey } from "@common/permission-keys"
import { REQUIRED_SCOPES_KEY } from "./authentication.guard"

export const AUTHORIZATION_KEY = "gezcez:authorization"
export const NETWORK_PARAM = "networkId"

export interface AuthorizationOptions {
	permission: PermissionKey
	scope: "global" | "network"
	sudo?: boolean
	description: string
}

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Express {
		interface Request {
			/** Resolved :networkId of a network-scoped route. */
			networkId?: number
		}
	}
}

@Injectable()
export class AuthorizationGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		@Inject(PERMISSION_RESOLVER) private readonly resolver: PermissionResolver,
	) {}

	canActivate(context: ExecutionContext): boolean {
		const options = this.reflector.get<AuthorizationOptions>(
			AUTHORIZATION_KEY,
			context.getHandler(),
		)
		if (!options) return true
		const req = context.switchToHttp().getRequest<Request>()
		if (!req.auth) throw new GezcezError("AUTH_REQUIRED")

		let networkId: number | undefined
		if (options.scope === "network") {
			const param = req.params[NETWORK_PARAM]
			networkId = typeof param === "string" ? this.resolver.resolveNetwork(param) : undefined
			if (networkId === undefined) throw new GezcezError("NOT_FOUND", "Unknown network")
			req.networkId = networkId
		}
		const permissions = this.resolver.forUser(req.auth.userId)
		if (!hasPermission(permissions, options.permission, networkId)) {
			throw new GezcezError("PERMISSION_MISSING", undefined, {
				permission: options.permission,
				scope: options.scope,
				...(networkId !== undefined ? { network_id: networkId } : {}),
			})
		}
		return true
	}
}

/**
 * Throws AUTH_STEP_UP_REQUIRED unless the token's auth_time is within the step-up window. Used by
 * StepUpGuard and by services where only some fields of a request need sudo.
 */
export function assertStepUp(req: Request, config: Pick<AppConfig, "stepUpMaxAgeS">): void {
	if (!req.auth) throw new GezcezError("AUTH_REQUIRED")
	const ageS = Date.now() / 1000 - req.auth.authTime
	if (ageS > config.stepUpMaxAgeS) {
		throw new GezcezError("AUTH_STEP_UP_REQUIRED", undefined, {
			max_age: config.stepUpMaxAgeS,
		})
	}
}

@Injectable()
export class StepUpGuard implements CanActivate {
	constructor(@InjectConfig() private readonly config: AppConfig) {}

	canActivate(context: ExecutionContext): boolean {
		assertStepUp(context.switchToHttp().getRequest<Request>(), this.config)
		return true
	}
}

export function UseAuthorization(options: AuthorizationOptions) {
	const sudo = options.sudo ?? false
	return applyDecorators(
		SetMetadata(AUTHORIZATION_KEY, { ...options, sudo }),
		SetMetadata(REQUIRED_SCOPES_KEY, ["dash"]),
		UseGuards(AuthorizationGuard, ...(sudo ? [StepUpGuard] : [])),
		ApiBearerAuth("bearer"),
		ApiExtension("x-gezcez-permission", { key: options.permission, scope: options.scope }),
		...(sudo ? [ApiExtension("x-gezcez-sudo", true)] : []),
	)
}
