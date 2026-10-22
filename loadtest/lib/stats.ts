// lib/stats.ts
// Latency samples and their summary (nearest-rank percentiles, milliseconds).

export interface LatencySummary {
	count: number
	min: number
	p50: number
	p95: number
	p99: number
	max: number
	mean: number
}

export function percentile(sorted: number[], p: number): number {
	if (!sorted.length) return Number.NaN
	const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
	return sorted[rank]!
}

export function summarize(samples: number[]): LatencySummary {
	const sorted = [...samples].sort((a, b) => a - b)
	const sum = sorted.reduce((acc, v) => acc + v, 0)
	return {
		count: sorted.length,
		min: sorted[0] ?? Number.NaN,
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		p99: percentile(sorted, 99),
		max: sorted.at(-1) ?? Number.NaN,
		mean: sorted.length ? sum / sorted.length : Number.NaN,
	}
}

/** `12.3` style rounding for tables; NaN prints as a dash. */
export function fmt(value: number, digits = 1): string {
	if (!Number.isFinite(value)) return "-"
	return value.toFixed(digits)
}

export function mb(bytes: number): string {
	return fmt(bytes / 1048576, 1)
}
