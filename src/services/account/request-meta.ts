// request-meta.ts
// Coarse, privacy-friendly description of where a session was created (plan 5.1 sessions).

import type { Request } from "express"
import type { AppConfig } from "@common/config"
import { clientIp, ipPrefix } from "@common/utils"

export interface RequestMeta {
	userAgent: string | null
	deviceLabel: string
	ipPrefix: string
	approxLocation: string | null
	kind: "desktop" | "mobile" | "app"
	os: string
	browser: string
}

function detectOs(ua: string): string {
	if (/iPhone|iPad|iPod/.test(ua)) return "iOS"
	if (/Android/.test(ua)) return "Android"
	if (/Mac OS X|Macintosh/.test(ua)) return "macOS"
	if (/Windows/.test(ua)) return "Windows"
	if (/CrOS/.test(ua)) return "ChromeOS"
	if (/Linux/.test(ua)) return "Linux"
	return "Unknown OS"
}

function detectBrowser(ua: string): string {
	if (/gezcez\//i.test(ua)) return "gezcez app"
	if (/Edg\//.test(ua)) return "Edge"
	if (/OPR\//.test(ua)) return "Opera"
	if (/Firefox\//.test(ua)) return "Firefox"
	if (/Chrome\//.test(ua)) return "Chrome"
	if (/Safari\//.test(ua)) return "Safari"
	return "Browser"
}

export function describeUserAgent(
	ua: string | undefined,
): Pick<RequestMeta, "deviceLabel" | "kind" | "os" | "browser"> {
	const value = ua ?? ""
	const os = detectOs(value)
	const browser = detectBrowser(value)
	const kind =
		browser === "gezcez app"
			? "app"
			: /Mobile|iPhone|Android/.test(value)
				? "mobile"
				: "desktop"
	return { deviceLabel: `${browser} on ${os}`, kind, os, browser }
}

export function requestMeta(req: Request, config: AppConfig): RequestMeta {
	const ua = req.headers["user-agent"]
	const header = (name: string) => {
		const value = req.headers[name]
		return Array.isArray(value) ? value[0] : value
	}
	const country = config.trustCfHeaders ? header("cf-ipcountry") : undefined
	const city = config.trustCfHeaders ? header("cf-ipcity") : undefined
	return {
		userAgent: ua ? ua.slice(0, 256) : null,
		...describeUserAgent(ua),
		ipPrefix: ipPrefix(clientIp(req, config.trustCfHeaders)),
		approxLocation: country ? [city, country].filter(Boolean).join(", ") : null,
	}
}
