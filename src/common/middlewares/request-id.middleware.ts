// request-id.middleware.ts
// Gives every request an id (cf-ray behind Cloudflare, a ULID otherwise) and echoes it as
// x-request-id. Registered with app.use() before anything else so the logger and the exception
// filter both see it.

import type { NextFunction, Request, Response } from "express"
import { ulid } from "ulid"

const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/

export function resolveRequestId(header: string | string[] | undefined, trusted: boolean): string {
	const value = Array.isArray(header) ? header[0] : header
	if (trusted && value && SAFE_ID.test(value)) return value
	return ulid()
}

export function requestIdMiddleware(trustCfHeaders: boolean) {
	return (req: Request, res: Response, next: NextFunction): void => {
		const id = resolveRequestId(req.headers["cf-ray"], trustCfHeaders)
		;(req as Request & { id: string }).id = id
		res.setHeader("x-request-id", id)
		next()
	}
}
