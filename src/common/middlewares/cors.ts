// cors.ts
// Per route group CORS (plan sections 6.1.0 and 9.2). Credentialed CORS is never global:
//  - identity routes (/v1/account/*, /v1/oauth/authorize*, /v1/oauth/logout and the oauth UI's
//    other /v1/oauth reads): only the identity UI origin (OAUTH_UI_URL), with credentials
//  - gz_rt routes (/v1/oauth/token, /v1/oauth/revoke): CORS_ORIGINS; credentials only for the
//    refresh cookie origins (CORS_ORIGINS minus the identity UI)
//  - everything else (bearer APIs): CORS_ORIGINS and the identity UI, never with credentials
// The cookie guards check the same origin sets server side, so CORS is not the only barrier.

import type { NextFunction, Request, Response } from "express"
import type { AppConfig } from "@common/config"
import { API_PREFIX } from "@common/constants"

export type CorsRouteGroup = "identity" | "refresh_cookie" | "bearer"

const ALLOWED_METHODS = "GET,HEAD,PUT,PATCH,POST,DELETE"
const ALLOWED_HEADERS = "Authorization,Content-Type,X-CSRF-Token,If-Match,Idempotency-Key"
const EXPOSED_HEADERS = "x-request-id,ETag,Retry-After"
const MAX_AGE_S = "600"

/** Scheme, host and port in canonical form, or undefined for anything that is not an origin. */
export function normaliseOrigin(origin: string | undefined): string | undefined {
	if (!origin || origin === "null") return undefined
	try {
		const url = new URL(origin)
		return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined
	} catch {
		return undefined
	}
}

function originSet(origins: string[]): Set<string> {
	return new Set(origins.map(normaliseOrigin).filter((origin) => origin !== undefined))
}

/** Origins that may use the session cookie routes: the identity UI only. */
export function identityOrigins(config: Pick<AppConfig, "oauthUiUrl">): Set<string> {
	return originSet([config.oauthUiUrl])
}

/** Origins that may spend a gz_rt cookie: CORS_ORIGINS minus the identity UI. */
export function refreshCookieOrigins(
	config: Pick<AppConfig, "oauthUiUrl" | "corsOrigins">,
): Set<string> {
	const identity = identityOrigins(config)
	return new Set([...originSet(config.corsOrigins)].filter((origin) => !identity.has(origin)))
}

export function corsRouteGroup(path: string): CorsRouteGroup {
	const prefix = `/${API_PREFIX}/`
	if (!path.startsWith(prefix)) return "bearer"
	const rest = path.slice(prefix.length).replace(/\/+$/, "")
	if (rest === "account" || rest.startsWith("account/")) return "identity"
	if (rest === "oauth/token" || rest === "oauth/revoke") return "refresh_cookie"
	if (rest.startsWith("oauth/")) return "identity"
	return "bearer"
}

export interface CorsDecision {
	credentials: boolean
}

/** Whether `origin` gets CORS on `path`, and whether with credentials. */
export function corsDecision(
	config: Pick<AppConfig, "oauthUiUrl" | "corsOrigins">,
	path: string,
	origin: string | undefined,
): CorsDecision | undefined {
	const normalised = normaliseOrigin(origin)
	if (!normalised) return undefined
	const identity = identityOrigins(config)
	const listed = originSet(config.corsOrigins)
	switch (corsRouteGroup(path)) {
		case "identity":
			return identity.has(normalised) ? { credentials: true } : undefined
		case "refresh_cookie":
			if (refreshCookieOrigins(config).has(normalised)) return { credentials: true }
			return listed.has(normalised) ? { credentials: false } : undefined
		default:
			return listed.has(normalised) || identity.has(normalised)
				? { credentials: false }
				: undefined
	}
}

export function corsMiddleware(config: Pick<AppConfig, "oauthUiUrl" | "corsOrigins">) {
	return (req: Request, res: Response, next: NextFunction): void => {
		res.vary("Origin")
		const origin = req.headers.origin
		const path = (req.originalUrl ?? req.url).split("?")[0]!
		const decision = corsDecision(config, path, origin)
		if (decision) {
			res.setHeader("Access-Control-Allow-Origin", origin!)
			if (decision.credentials) res.setHeader("Access-Control-Allow-Credentials", "true")
			res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS)
		}
		if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
			if (decision) {
				res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS)
				res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS)
				res.setHeader("Access-Control-Max-Age", MAX_AGE_S)
			}
			res.statusCode = 204
			res.setHeader("Content-Length", "0")
			res.end()
			return
		}
		next()
	}
}
