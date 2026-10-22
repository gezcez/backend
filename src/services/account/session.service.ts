// session.service.ts
// The identity (SSO) session behind __Host-gz_session: 30 days sliding, 90 days absolute,
// bound to the device cookie, a new token on every sign-in (no fixation).

import { Injectable } from "@nestjs/common"
import type { Request, Response } from "express"
import type { DeviceContext, SessionContext } from "@common/auth.types"
import { InjectConfig, type AppConfig } from "@common/config"
import type { AuthMethod } from "@common/jwt.types"
import { newId, randomToken, sha256Hex } from "@common/utils"
import { requestMeta } from "./request-meta"
import { RevokedSessionsService } from "./revoked-sessions.service"
import {
	SessionRepository,
	type SessionRevokeReason,
	type SessionRow,
	type SessionWithUser,
} from "./session.repository"

export const SESSION_COOKIE = "__Host-gz_session"
export const SESSION_SLIDING_MS = 30 * 24 * 3600_000
export const SESSION_ABSOLUTE_MS = 90 * 24 * 3600_000
const TOUCH_INTERVAL_MS = 5 * 60_000

export function isLive(session: SessionWithUser, now: Date): boolean {
	return (
		!session.revoked_at &&
		session.expires_at > now &&
		session.absolute_expires_at > now &&
		(session.user.status === "active" || session.user.status === "pending_deletion")
	)
}

export function toContext(session: SessionWithUser): SessionContext {
	return {
		id: session.id,
		userId: session.user_id,
		publicId: session.user.public_id,
		authTime: session.auth_time,
		amr: session.amr,
		expiresAt: session.expires_at,
	}
}

@Injectable()
export class SessionService {
	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly repository: SessionRepository,
		private readonly revokedSessions: RevokedSessionsService,
	) {}

	/** Creates a session, sets the cookie, and signs out older sessions of the same user here. */
	create(
		req: Request,
		res: Response,
		input: { userId: number; device: DeviceContext; amr: AuthMethod[] },
	): SessionContext {
		const now = new Date()
		const token = randomToken()
		const meta = requestMeta(req, this.config)
		const id = newId()
		const absolute = new Date(now.getTime() + SESSION_ABSOLUTE_MS)
		this.repository.insert({
			id,
			user_id: input.userId,
			token_hash: sha256Hex(token),
			device_id_hash: input.device.hash,
			auth_time: now,
			amr: input.amr,
			user_agent: meta.userAgent,
			device_label: meta.deviceLabel,
			ip_prefix: meta.ipPrefix,
			approx_location: meta.approxLocation,
			created_at: now,
			last_seen_at: now,
			expires_at: new Date(now.getTime() + SESSION_SLIDING_MS),
			absolute_expires_at: absolute,
			signed_out_at: null,
			revoked_at: null,
			revoke_reason: null,
			forgotten_at: null,
		})
		const replaced = this.repository.liveIdsForUserOnDevice(input.userId, input.device.hash, id)
		this.revoke(replaced, "replaced", false)
		this.setCookie(res, token, absolute)
		const created = this.repository.findById(id)!
		req.session = toContext(created)
		return req.session
	}

	/** Reads the cookie; returns the live session bound to this device, sliding its expiry. */
	resolve(req: Request, device: DeviceContext): SessionContext | null {
		const token = req.cookies?.[SESSION_COOKIE] as string | undefined
		if (!token || token.length > 128) return null
		const session = this.repository.findByTokenHash(sha256Hex(token))
		const now = new Date()
		if (!session || session.device_id_hash !== device.hash || !isLive(session, now)) return null
		if (now.getTime() - session.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
			const expires = new Date(
				Math.min(now.getTime() + SESSION_SLIDING_MS, session.absolute_expires_at.getTime()),
			)
			this.repository.touch(session.id, now, expires)
			session.expires_at = expires
		}
		return toContext(session)
	}

	find(id: string): SessionWithUser | undefined {
		return this.repository.findById(id)
	}

	/** Marks a fresh authentication on the current session (re-auth / step-up). */
	reauthenticate(req: Request, sessionId: string, method: AuthMethod): SessionContext {
		const session = this.repository.findById(sessionId)!
		const amr = [...new Set<AuthMethod>([method, ...session.amr])]
		const now = new Date()
		this.repository.updateAuth(sessionId, now, amr)
		req.session = { ...toContext(session), authTime: now, amr }
		return req.session
	}

	/** Makes another live session of this device the active one (gets a fresh cookie token). */
	switchTo(
		req: Request,
		res: Response,
		sessionId: string,
		device: DeviceContext,
	): SessionContext | null {
		const session = this.repository.findById(sessionId)
		const now = new Date()
		if (!session || session.device_id_hash !== device.hash || !isLive(session, now)) return null
		const token = randomToken()
		this.repository.replaceToken(session.id, sha256Hex(token), now)
		this.setCookie(res, token, session.absolute_expires_at)
		req.session = toContext(session)
		return req.session
	}

	/** Revokes sessions (and their refresh families) and blocks their access tokens at once. */
	revoke(ids: string[], reason: SessionRevokeReason, signedOut: boolean): string[] {
		const revoked = this.repository.revoke(ids, reason, new Date(), signedOut)
		this.revokedSessions.add(revoked)
		return revoked
	}

	revokeAllForUser(userId: number, reason: SessionRevokeReason): string[] {
		return this.revoke(this.repository.liveIdsForUser(userId), reason, false)
	}

	/** Every live session of the user except `exceptId` ("sign out everywhere else"). */
	revokeOthers(userId: number, exceptId: string, reason: SessionRevokeReason): string[] {
		const ids = this.repository.liveIdsForUser(userId).filter((id) => id !== exceptId)
		return this.revoke(ids, reason, false)
	}

	listLive(userId: number): SessionRow[] {
		return this.repository.listLiveForUser(userId, new Date())
	}

	liveIdsForDevice(deviceHash: string): string[] {
		return this.repository.liveIdsForDevice(deviceHash)
	}

	/**
	 * "Forget this account" in the chooser: signs out the user's live sessions on this device and
	 * hides all of them from it. Returns the user id, or null when the session is not this device's.
	 */
	forgetOnDevice(sessionId: string, deviceHash: string): number | null {
		const session = this.repository.findById(sessionId)
		if (!session || session.device_id_hash !== deviceHash || session.forgotten_at) return null
		const live = this.repository.liveIdsForUserOnDevice(session.user_id, deviceHash, "")
		this.revoke(live, "logout", false)
		this.repository.forgetOnDevice(session.user_id, deviceHash, new Date())
		return session.user_id
	}

	listByDevice(deviceHash: string): SessionWithUser[] {
		return this.repository.listByDevice(deviceHash)
	}

	setCookie(res: Response, token: string, absoluteExpiry: Date): void {
		res.cookie(SESSION_COOKIE, token, {
			httpOnly: true,
			secure: true,
			sameSite: "lax",
			path: "/",
			expires: absoluteExpiry,
		})
	}

	clearCookie(res: Response): void {
		res.clearCookie(SESSION_COOKIE, {
			httpOnly: true,
			secure: true,
			sameSite: "lax",
			path: "/",
		})
	}
}
