// redirect-uris.ts
// Redirect URI rules (plan 6.2), the same ones the dashboard checks before saving: https only,
// except http://localhost:<port> and http://127.0.0.1:<port> for dev clients and custom schemes
// for native clients; exact match, so no wildcards and no fragments.

import type { AppPlatform } from "@schemas/core"

export type RedirectUriProblem =
	| "invalid"
	| "https_required"
	| "custom_scheme_native_only"
	| "wildcard"
	| "fragment"
	| "duplicate"

const LOOPBACK = new Set(["localhost", "127.0.0.1"])

export function redirectUriProblem(uri: string, platform: AppPlatform): RedirectUriProblem | null {
	if (uri.includes("*")) return "wildcard"
	let url: URL
	try {
		url = new URL(uri)
	} catch {
		return "invalid"
	}
	if (url.hash || uri.includes("#")) return "fragment"
	if (url.protocol === "https:") return url.hostname ? null : "invalid"
	if (url.protocol === "http:") {
		return platform === "dev" && LOOPBACK.has(url.hostname) && url.port !== ""
			? null
			: "https_required"
	}
	if (/^[a-z][a-z0-9+.-]*:$/.test(url.protocol))
		return platform === "native" ? null : "custom_scheme_native_only"
	return "invalid"
}

/** `uri: problem` for every bad entry; empty when the list is acceptable. */
export function redirectUriProblems(uris: string[], platform: AppPlatform): string[] {
	return uris.flatMap((uri, index) => {
		const problem =
			uris.indexOf(uri) !== index ? "duplicate" : redirectUriProblem(uri, platform)
		return problem ? [`${uri}: ${problem}`] : []
	})
}
