// ip.utils.ts
// Trusted client IP and privacy-preserving IP hashes.

import type { Request } from "express"
import { hmacHex } from "./crypto.utils"

/** CF-Connecting-IP only when the request came through the Cloudflare tunnel. */
export function clientIp(req: Request, trustCfHeaders: boolean): string {
	if (trustCfHeaders) {
		const header = req.headers["cf-connecting-ip"]
		const value = Array.isArray(header) ? header[0] : header
		if (value) return value.trim()
	}
	const raw = req.socket?.remoteAddress ?? "unknown"
	return raw.startsWith("::ffff:") ? raw.slice(7) : raw
}

/** Hash with a salt that rotates daily, so hashes cannot be joined across days. */
export function hashIp(ip: string, secret: string, now = new Date()): string {
	const day = now.toISOString().slice(0, 10)
	return hmacHex(secret, `ip:${day}:${ip}`).slice(0, 32)
}

/** Coarse network prefix for session lists: /24 for IPv4, /48 for IPv6. */
export function ipPrefix(ip: string): string {
	if (ip.includes(".") && !ip.includes(":")) {
		const parts = ip.split(".")
		return parts.length === 4 ? `${parts.slice(0, 3).join(".")}.0/24` : ip
	}
	if (ip.includes(":")) {
		const groups = ip.split(":").filter(Boolean)
		return `${groups.slice(0, 3).join(":")}::/48`
	}
	return ip
}
