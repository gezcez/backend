// lib/http.ts
// Closed-loop HTTP load: `concurrency` workers each send the next request as soon as the last one
// finished, for `durationS` seconds after a short unrecorded warm-up.

import { summarize, type LatencySummary } from "./stats"

export interface HttpRunOptions {
	name: string
	concurrency: number
	durationS: number
	warmupS?: number
	/** Builds request i (URL and init); called once per request. */
	request: (i: number) => { url: string; init?: RequestInit }
}

export interface HttpRunResult {
	name: string
	concurrency: number
	durationS: number
	requests: number
	rps: number
	latency: LatencySummary
	statuses: Record<string, number>
	errors: number
	avgBytes: number
}

export async function runHttp(options: HttpRunOptions): Promise<HttpRunResult> {
	const warmupUntil = performance.now() + (options.warmupS ?? 2) * 1000
	let recordFrom = 0
	let endAt = 0
	const latencies: number[] = []
	const statuses: Record<string, number> = {}
	let errors = 0
	let bytes = 0
	let counter = 0

	const worker = async () => {
		for (;;) {
			const now = performance.now()
			if (endAt && now >= endAt) return
			const { url, init } = options.request(counter++)
			const started = performance.now()
			let status = "error"
			let size = 0
			try {
				const response = await fetch(url, init)
				size = (await response.arrayBuffer()).byteLength
				status = String(response.status)
			} catch {
				errors++
			}
			const finished = performance.now()
			if (recordFrom && started >= recordFrom && finished <= endAt) {
				latencies.push(finished - started)
				statuses[status] = (statuses[status] ?? 0) + 1
				bytes += size
			}
		}
	}

	const workers = Array.from({ length: options.concurrency }, worker)
	await Bun.sleep(Math.max(0, warmupUntil - performance.now()))
	recordFrom = performance.now()
	endAt = recordFrom + options.durationS * 1000
	await Promise.all(workers)
	return {
		name: options.name,
		concurrency: options.concurrency,
		durationS: options.durationS,
		requests: latencies.length,
		rps: latencies.length / options.durationS,
		latency: summarize(latencies),
		statuses,
		errors,
		avgBytes: latencies.length ? bytes / latencies.length : 0,
	}
}
