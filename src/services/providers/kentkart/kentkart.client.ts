// kentkart.client.ts
// HTTP wrapper for Kentkart: identifiable User-Agent, no cache-busting query (Cache-Control
// instead), timeouts, the JSON `result` envelope and the shared upstream limiter.

import { ProviderError } from "../transit-provider.interface"
import type { UpstreamLimiter } from "../upstream-limiter"
import type { FetchFn } from "./kentkart.auth"
import { kentkartError } from "./kentkart.errors"
import type { KentkartEnvelope } from "./kentkart.types"

export interface KentkartClientOptions {
	fetchFn: FetchFn
	limiter: UpstreamLimiter
	userAgent: string
}

export interface BinaryResponse {
	status: number
	body: Uint8Array
	retryAfterS?: number
}

export function retryAfterSeconds(header: string | null): number | undefined {
	if (!header) return undefined
	const seconds = Number(header)
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3600)
	const date = Date.parse(header)
	if (Number.isFinite(date)) return Math.max(0, Math.min(3600, (date - Date.now()) / 1000))
	return undefined
}

/** Throws a ProviderError when the envelope carries a non-zero code. */
export function checkEnvelope(body: KentkartEnvelope): void {
	const raw = body.result?.code
	if (raw === undefined || raw === null || raw === "") return
	const code = Number(raw)
	if (!Number.isFinite(code) || code === 0) return
	const info = kentkartError(code)
	const kind =
		info.class === "auth"
			? "auth"
			: info.class === "rate_limited"
				? "rate_limited"
				: "upstream_error"
	throw new ProviderError(kind, `Kentkart error ${code}: ${info.message}`, {
		upstreamCode: code,
	})
}

export class KentkartClient {
	constructor(private readonly options: KentkartClientOptions) {}

	private headers(token?: string): Record<string, string> {
		return {
			"User-Agent": this.options.userAgent,
			"Cache-Control": "no-cache",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		}
	}

	private async request(
		url: string,
		init: { token?: string; accept: string; timeoutMs: number; signal?: AbortSignal },
	): Promise<Response> {
		const host = new URL(url).host
		const timeout = AbortSignal.timeout(init.timeoutMs)
		const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
		try {
			return await this.options.limiter.run(
				host,
				() =>
					this.options.fetchFn(url, {
						headers: { ...this.headers(init.token), Accept: init.accept },
						signal,
					}),
				init.signal,
			)
		} catch (error) {
			if (init.signal?.aborted) throw error
			if (timeout.aborted || (error as Error).name === "TimeoutError")
				throw new ProviderError(
					"timeout",
					`Kentkart request timed out after ${init.timeoutMs} ms`,
				)
			throw new ProviderError("upstream_error", "Kentkart request failed: network error")
		}
	}

	async getBinary(
		url: string,
		init: { token?: string; timeoutMs: number; signal?: AbortSignal },
	): Promise<BinaryResponse> {
		const response = await this.request(url, { ...init, accept: "application/x-protobuf, */*" })
		const body = new Uint8Array(await response.arrayBuffer())
		return {
			status: response.status,
			body,
			retryAfterS: retryAfterSeconds(response.headers.get("retry-after")),
		}
	}

	async getJson<T extends KentkartEnvelope>(
		url: string,
		init: { token?: string; timeoutMs: number; signal?: AbortSignal },
	): Promise<T> {
		const response = await this.request(url, { ...init, accept: "application/json" })
		if (response.status === 429 || response.status === 503) {
			throw new ProviderError("rate_limited", `Kentkart answered ${response.status}`, {
				httpStatus: response.status,
				retryAfterS: retryAfterSeconds(response.headers.get("retry-after")),
			})
		}
		if (!response.ok) {
			throw new ProviderError("upstream_error", `Kentkart answered ${response.status}`, {
				httpStatus: response.status,
			})
		}
		let body: T
		try {
			body = (await response.json()) as T
		} catch {
			throw new ProviderError("decode_error", "Kentkart returned invalid JSON")
		}
		checkEnvelope(body)
		return body
	}
}
