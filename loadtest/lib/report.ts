// lib/report.ts
// Markdown tables for a run's results (pasted into loadtest/RESULTS.md).

import type { RestResult } from "../scenarios/rest"
import type { TokenResult } from "../scenarios/token"
import type { WsResult } from "../scenarios/ws"
import type { ProcSummary } from "./proc"
import { fmt } from "./stats"

export interface RunReport {
	startedAt: string
	machine: string
	vehicles: number
	pollIntervalS: number
	rest?: RestResult[]
	ws?: WsResult[]
	token?: TokenResult
}

const cpu = (p?: ProcSummary) => (p ? `${fmt(p.cpuAvgPct, 0)} / ${fmt(p.cpuPeakPct, 0)}` : "-")
const rss = (p?: ProcSummary) => (p ? `${fmt(p.rssStartMb, 0)} → ${fmt(p.rssPeakMb, 0)}` : "-")
const statuses = (s: Record<string, number>) =>
	Object.entries(s)
		.map(([k, v]) => `${k}: ${v}`)
		.join(", ")

export function markdown(report: RunReport): string {
	const out: string[] = []
	out.push(
		`Run ${report.startedAt} on ${report.machine}; fake fleet ${report.vehicles} vehicles, poll every ${report.pollIntervalS} s.`,
		"",
	)
	if (report.rest?.length) {
		out.push(
			"### Public REST",
			"",
			"| Endpoint | Conc. | req/s | p50 ms | p95 ms | p99 ms | Body KB | Statuses | Server CPU % avg/peak | Server RSS MB |",
			"| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |",
		)
		for (const r of report.rest)
			out.push(
				`| ${r.name} | ${r.concurrency} | ${fmt(r.rps, 0)} | ${fmt(r.latency.p50)} | ${fmt(r.latency.p95)} | ${fmt(r.latency.p99)} | ${fmt(r.avgBytes / 1024)} | ${statuses(r.statuses)}${r.errors ? `, errors: ${r.errors}` : ""} | ${cpu(r.server)} | ${rss(r.server)} |`,
			)
		out.push("")
	}
	if (report.ws?.length) {
		out.push(
			"### WebSocket fan-out (vehicles channel, whole network)",
			"",
			"| Clients | Subscribed | Connect p50/p95 ms | Snapshot p50/p95 ms | Snapshot KB | msgs/s | MB/s out | Delta KB | Fan-out spread p50/p95 ms | Feed lag p50/p95 ms | Dropped | Server CPU % avg/peak | Server RSS MB |",
			"| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
		)
		for (const w of report.ws)
			out.push(
				`| ${w.clients} | ${w.subscribed} | ${fmt(w.connectMs.p50)} / ${fmt(w.connectMs.p95)} | ${fmt(w.snapshotMs.p50)} / ${fmt(w.snapshotMs.p95)} | ${fmt(w.snapshotBytes / 1024)} | ${fmt(w.msgsPerS)} | ${fmt(w.mbPerS)} | ${fmt(w.avgDeltaBytes / 1024)} | ${fmt(w.spreadMs.p50, 0)} / ${fmt(w.spreadMs.p95, 0)} | ${fmt(w.feedLagMs.p50, 0)} / ${fmt(w.feedLagMs.p95, 0)} | ${w.closedDuringWindow} | ${cpu(w.serverWindow)} | ${rss(w.serverConnect)} → ${fmt(w.serverWindow?.rssPeakMb ?? Number.NaN, 0)} |`,
			)
		out.push("")
		for (const w of report.ws)
			out.push(
				`- ${w.clients} clients, feeds in window: ${w.feeds.map((f) => `${f.clients} clients in ${f.spreadMs} ms`).join("; ") || "none"}; connect phase server CPU ${cpu(w.serverConnect)}`,
			)
		out.push("")
	}
	if (report.token) {
		const t = report.token
		out.push(
			"### Token endpoint refresh",
			"",
			`${t.families} refresh token families (setup ${fmt(t.setupMs / 1000)} s).`,
			"",
			"| Phase | Requests | req/s | p50 ms | p95 ms | p99 ms | Statuses | Server CPU % avg/peak | Server RSS MB |",
			"| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |",
		)
		for (const p of t.phases)
			out.push(
				`| ${p.name} | ${p.requests} | ${fmt(p.rps, 0)} | ${fmt(p.latency.p50)} | ${fmt(p.latency.p95)} | ${fmt(p.latency.p99)} | ${statuses(p.statuses)} | ${cpu(p.server)} | ${rss(p.server)} |`,
			)
		const d = t.duplicate
		out.push(
			"",
			`Duplicate burst: ${d.sent} concurrent uses of one token, ${d.ok} accepted, ${d.rejected} rejected, ${d.distinctTokens} distinct successors, family usable afterwards: ${d.familyAlive}.`,
			"",
		)
	}
	return out.join("\n")
}
