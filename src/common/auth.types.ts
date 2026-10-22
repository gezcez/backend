// auth.types.ts
// What the guards attach to the request, and the interfaces the account and OAuth modules
// implement for them (injected by token, so common/ never imports services/).

import type { Request, Response } from "express"
import type { AuthMethod, RequestAuth } from "./jwt.types"

export interface DeviceContext {
	/** Raw __Host-gz_device value; never logged, stored only as `hash`. */
	id: string
	hash: string
	/** True when this request issued the cookie. */
	isNew: boolean
}

export interface SessionContext {
	id: string
	userId: number
	publicId: string
	authTime: Date
	amr: AuthMethod[]
	expiresAt: Date
}

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Express {
		interface Request {
			id: string
			auth?: RequestAuth
			device?: DeviceContext
			session?: SessionContext
		}
	}
}

/** Cookie side of authentication, implemented by the account module. */
export interface CookieAuthProvider {
	ensureDevice(req: Request, res: Response): DeviceContext
	resolveSession(req: Request, device: DeviceContext): Promise<SessionContext | null>
	csrfTokens(device: DeviceContext, session: SessionContext | null): string[]
}
export const COOKIE_AUTH = Symbol("COOKIE_AUTH")

/** Bearer side, implemented by the OAuth module. */
export interface BearerAuthProvider {
	authenticate(token: string): Promise<RequestAuth>
}
export const BEARER_AUTH = Symbol("BEARER_AUTH")

export type AuthKind = "bearer" | "public" | "device" | "session"
export const AUTH_KIND_KEY = "gezcez:auth-kind"
