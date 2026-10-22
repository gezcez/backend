// device.service.ts
// __Host-gz_device: a random 128-bit id that groups sessions per browser (account chooser,
// "this device", device-wide sign-out). Stored only as a hash; never in tokens.

import { Injectable } from "@nestjs/common"
import type { Request, Response } from "express"
import type { DeviceContext } from "@common/auth.types"
import { randomToken, sha256Hex } from "@common/utils"

export const DEVICE_COOKIE = "__Host-gz_device"
const DEVICE_MAX_AGE_MS = 2 * 365 * 24 * 3600_000
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/

@Injectable()
export class DeviceService {
	ensure(req: Request, res: Response): DeviceContext {
		const existing = req.cookies?.[DEVICE_COOKIE] as string | undefined
		if (existing && DEVICE_ID.test(existing))
			return { id: existing, hash: sha256Hex(existing), isNew: false }
		const id = randomToken(16)
		res.cookie(DEVICE_COOKIE, id, {
			httpOnly: true,
			secure: true,
			sameSite: "lax",
			path: "/",
			maxAge: DEVICE_MAX_AGE_MS,
		})
		return { id, hash: sha256Hex(id), isNew: true }
	}
}
