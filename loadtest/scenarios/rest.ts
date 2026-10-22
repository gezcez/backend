// scenarios/rest.ts
// Public REST reads a rider app makes: city list, city manifest, stop departures, nearby stops,
// and live vehicles for the whole network (the full 2,000-vehicle list) and for a small bbox.

import { runHttp, type HttpRunResult } from "../lib/http"
import { measured, type ProcSummary } from "../lib/proc"

export interface RestOptions {
	baseUrl: string
	serverPid?: number
	concurrency: number
	durationS: number
	city: string
	networkId: number
	stopId: string
	lat: number
	lon: number
}

export interface RestResult extends HttpRunResult {
	path: string
	server?: ProcSummary
	client: ProcSummary
}

export async function restScenario(options: RestOptions): Promise<RestResult[]> {
	const { lat, lon } = options
	const bbox = [lon - 0.005, lat - 0.005, lon + 0.005, lat + 0.005].map((v) => v.toFixed(5))
	const cases: { name: string; path: string }[] = [
		{ name: "cities", path: "/v1/cities" },
		{ name: "manifest", path: `/v1/cities/${options.city}/manifest` },
		{ name: "departures", path: `/v1/stops/${options.stopId}/departures?limit=10` },
		{ name: "nearby", path: `/v1/stops/nearby?lat=${lat}&lon=${lon}&radius=500&limit=20` },
		{ name: "vehicles (network)", path: `/v1/networks/${options.networkId}/vehicles` },
		{
			name: "vehicles (bbox)",
			path: `/v1/networks/${options.networkId}/vehicles?bbox=${bbox.join(",")}`,
		},
	]
	const results: RestResult[] = []
	for (const c of cases) {
		const run = await measured(options.serverPid, () =>
			runHttp({
				name: c.name,
				concurrency: options.concurrency,
				durationS: options.durationS,
				// A few distinct client IPs, like riders behind the tunnel.
				request: (i) => ({
					url: options.baseUrl + c.path,
					init: { headers: { "cf-connecting-ip": `10.1.${(i >> 8) & 255}.${i & 255}` } },
				}),
			}),
		)
		results.push({ ...run.result, path: c.path, server: run.server, client: run.client })
	}
	return results
}
