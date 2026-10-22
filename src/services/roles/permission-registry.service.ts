// permission-registry.service.ts
// At boot, scans every controller for @UseAuthorization metadata (DiscoveryService +
// MetadataScanner), fails the boot on a key that is not in permission-keys.ts, upserts every key
// from code, marks keys no longer in code as orphaned, and rebuilds the (method, path) route
// registry. Code is the source of truth; nothing writes at import time (plan section 6.4).
// Class-level @UseAuthorization counts (handler metadata wins). A /v1/dash route with neither a
// permission nor the dash scope fails the boot.

import { Injectable, Logger, RequestMethod, type OnApplicationBootstrap } from "@nestjs/common"
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants"
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core"
import { API_PREFIX } from "@common/constants"
import { REQUIRED_SCOPES_KEY } from "@common/middlewares/authentication.guard"
import {
	AUTHORIZATION_KEY,
	type AuthorizationOptions,
} from "@common/middlewares/authorization.guard"
import { isPermissionKey, PERMISSION_KEYS, PERMISSIONS, storedScope } from "@common/permission-keys"
import { RolesRepository, type RouteRecord } from "./roles.repository"

function joinPath(...parts: (string | string[] | undefined)[]): string {
	const segments = parts
		.map((part) => (Array.isArray(part) ? part[0] : part) ?? "")
		.flatMap((part) => part.split("/"))
		.filter(Boolean)
	// "permissions\\:batch" escapes the colon for the router; the registry stores the real path.
	return `/${segments.join("/")}`.replace(/\\:/g, ":")
}

@Injectable()
export class PermissionRegistryService implements OnApplicationBootstrap {
	private readonly logger = new Logger("PermissionRegistry")
	private routes: RouteRecord[] = []

	constructor(
		private readonly discovery: DiscoveryService,
		private readonly scanner: MetadataScanner,
		private readonly reflector: Reflector,
		private readonly repository: RolesRepository,
	) {}

	onApplicationBootstrap(): void {
		this.routes = this.scan()
		const sudoKeys = new Set(this.routes.filter((r) => r.sudo).map((r) => r.permission_key))
		const now = new Date()
		const { orphaned } = this.repository.syncPermissions(
			PERMISSION_KEYS.map((key) => ({
				key,
				scope: storedScope(key),
				description: PERMISSIONS[key].description,
				sudo: sudoKeys.has(key),
			})),
			now,
		)
		this.repository.syncRoutes(this.routes, now)
		this.logger.log(
			`${PERMISSION_KEYS.length} permission keys, ${this.routes.length} guarded routes` +
				(orphaned ? `, ${orphaned} keys orphaned` : ""),
		)
	}

	/** Guarded routes found in the running app. */
	registered(): readonly RouteRecord[] {
		return this.routes
	}

	scan(): RouteRecord[] {
		const routes: RouteRecord[] = []
		for (const wrapper of this.discovery.getControllers()) {
			const instance = wrapper.instance as object | undefined
			if (!instance || !wrapper.metatype) continue
			const controllerPath = this.reflector.get<string | string[]>(
				PATH_METADATA,
				wrapper.metatype,
			)
			const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>
			for (const name of this.scanner.getAllMethodNames(prototype)) {
				const handler = prototype[name] as (...args: unknown[]) => unknown
				const method = this.reflector.get<RequestMethod | undefined>(
					METHOD_METADATA,
					handler,
				)
				if (method === undefined) continue
				const path = joinPath(
					API_PREFIX,
					controllerPath,
					this.reflector.get<string | string[]>(PATH_METADATA, handler),
				)
				const options = this.reflector.getAllAndOverride<AuthorizationOptions | undefined>(
					AUTHORIZATION_KEY,
					[handler, wrapper.metatype],
				)
				if (!options) {
					// A dashboard route declares a permission, or at least the dash scope when it
					// filters by permission itself (fail the boot, never open).
					const scopes = this.reflector.getAllAndMerge<string[]>(REQUIRED_SCOPES_KEY, [
						handler,
						wrapper.metatype,
					])
					const dash =
						path === `/${API_PREFIX}/dash` || path.startsWith(`/${API_PREFIX}/dash/`)
					if (dash && !scopes.includes("dash"))
						throw new Error(
							`${wrapper.name}.${name} (${path}) has neither @UseAuthorization nor the dash scope`,
						)
					continue
				}
				if (!isPermissionKey(options.permission)) {
					throw new Error(
						`${wrapper.name}.${name} uses unknown permission key "${options.permission}"`,
					)
				}
				const keyScope = PERMISSIONS[options.permission].scope
				if (options.scope === "network" && keyScope === "global") {
					throw new Error(
						`${wrapper.name}.${name}: "${options.permission}" is a global key on a network route`,
					)
				}
				if (options.scope === "network" && !path.includes(":networkId")) {
					throw new Error(
						`${wrapper.name}.${name}: network routes need a :networkId param`,
					)
				}
				routes.push({
					method: RequestMethod[method],
					path,
					permission_key: options.permission,
					scope: options.scope,
					sudo: options.sudo ?? false,
					description: options.description,
				})
			}
		}
		return routes.sort(
			(a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
		)
	}
}
