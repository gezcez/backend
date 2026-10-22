// test/helpers/kentkart.ts
// Loads the Kentkart fixtures (scrubbed shapes of recorded responses; no test calls upstream) and
// builds a stub fetch that answers by URL.

import fs from "node:fs"
import path from "node:path"
import { transit_realtime } from "gtfs-realtime-bindings"

const DIR = path.resolve(import.meta.dir, "../fixtures/kentkart")

export function fixtureJson<T = unknown>(name: string): T {
	return JSON.parse(fs.readFileSync(path.join(DIR, name), "utf8")) as T
}

/** Encodes a FeedMessage given as JSON (vehicles.json shape) to GTFS-RT protobuf bytes. */
export function encodeFeed(json: unknown): Uint8Array {
	const message = transit_realtime.FeedMessage.fromObject(json as Record<string, unknown>)
	return transit_realtime.FeedMessage.encode(message).finish()
}

export function vehiclesPb(
	overrides?: (json: { header: { timestamp: number } }) => void,
): Uint8Array {
	const json = fixtureJson<{ header: { timestamp: number } }>("vehicles.json")
	overrides?.(json)
	return encodeFeed(json)
}

/** Base64url JWT with the given payload (signature is junk; Kentkart tokens are only decoded). */
export function fakeJwt(payload: Record<string, unknown>): string {
	const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
	return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(payload)}.sig`
}

export interface StubCall {
	url: string
	init?: RequestInit
}

export type StubRoute = (url: URL, init?: RequestInit) => Response | Promise<Response>

/** fetch replacement: the first route whose predicate matches answers; records every call. */
export function stubFetch(routes: [(url: URL) => boolean, StubRoute][]) {
	const calls: StubCall[] = []
	const fn = async (input: string, init?: RequestInit): Promise<Response> => {
		calls.push({ url: input, init })
		const url = new URL(input)
		for (const [match, answer] of routes) if (match(url)) return answer(url, init)
		return new Response("not found", { status: 404 })
	}
	return { fn, calls }
}

export function protobufResponse(body: Uint8Array, status = 200): Response {
	return new Response(body, { status, headers: { "content-type": "application/x-protobuf" } })
}

export function jsonResponse(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	})
}
