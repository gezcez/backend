// lib/target.ts
// The ApiTarget the test helpers (TestBrowser, TestOAuthClient) drive, for a running server.

import type { ApiTarget } from "@test/helpers/app"

export function target(baseUrl: string, oauthUiUrl = "http://localhost:5174"): ApiTarget {
	const url = baseUrl.replace(/\/$/, "")
	const doFetch = (pathname: string, init?: RequestInit) => fetch(url + pathname, init)
	return {
		config: { oauthUiUrl, issuer: url },
		fetch: doFetch,
		async json<T>(pathname: string, init?: RequestInit) {
			const response = await doFetch(pathname, init)
			const text = await response.text()
			return {
				status: response.status,
				headers: response.headers,
				body: (text ? JSON.parse(text) : null) as T,
			}
		},
	}
}
