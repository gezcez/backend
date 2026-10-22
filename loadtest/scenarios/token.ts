// scenarios/token.ts
// POST /v1/oauth/token refresh bursts. Setup signs the fixture rider in once and runs the code
// flow `families` times, so each family has its own rotating refresh token (like many devices).
//   burst      every family refreshes at the same instant, `rounds` times (app resume storms)
//   sustained  closed loop, each worker rotating its own families for `durationS`
//   duplicate  one token sent `duplicates` times at once (several tabs); the grace window decides

import { TestBrowser } from "@test/helpers/browser"
import { TestOAuthClient } from "@test/helpers/oauth-client"
import { measured, type ProcSummary } from "../lib/proc"
import { summarize, type LatencySummary } from "../lib/stats"
import { target } from "../lib/target"

export interface TokenOptions {
	baseUrl: string
	serverPid?: number
	families: number
	rounds: number
	durationS: number
	concurrency: number
	duplicates: number
	email: string
}

export interface TokenPhase {
	name: string
	requests: number
	wallMs: number
	rps: number
	latency: LatencySummary
	statuses: Record<string, number>
	server?: ProcSummary
	client: ProcSummary
}

export interface TokenResult {
	families: number
	setupMs: number
	phases: TokenPhase[]
	duplicate: { sent: number; ok: number; rejected: number; distinctTokens: number; familyAlive: boolean }
}

function phase(
	name: string,
	latencies: number[],
	statuses: Record<string, number>,
	wallMs: number,
	m: { server?: ProcSummary; client: ProcSummary },
): TokenPhase {
	return {
		name,
		requests: latencies.length,
		wallMs,
		rps: latencies.length / (wallMs / 1000),
		latency: summarize(latencies),
		statuses,
		server: m.server,
		client: m.client,
	}
}

export async function tokenScenario(options: TokenOptions): Promise<TokenResult> {
	const t = target(options.baseUrl)
	const setupStarted = performance.now()
	const browser = new TestBrowser(t)
	await browser.signIn(options.email)
	const tokens: string[] = []
	const client = new TestOAuthClient(t)
	for (let i = 0; i < options.families; i++) {
		const flow = new TestOAuthClient(t)
		const { code } = await flow.signInAndAuthorize(browser)
		const token = await flow.exchange(code!)
		if (token.status !== 200 || !token.body.refresh_token)
			throw new Error(`exchange failed: ${JSON.stringify(token.body)}`)
		tokens.push(token.body.refresh_token)
	}
	const setupMs = performance.now() - setupStarted

	const refresh = async (
		index: number,
		latencies: number[],
		statuses: Record<string, number>,
	): Promise<void> => {
		const started = performance.now()
		const res = await client.refresh(tokens[index]!)
		latencies.push(performance.now() - started)
		statuses[res.status] = (statuses[res.status] ?? 0) + 1
		if (res.status === 200 && res.body.refresh_token) tokens[index] = res.body.refresh_token
	}

	const phases: TokenPhase[] = []

	// Burst: all families at once, several rounds.
	{
		const latencies: number[] = []
		const statuses: Record<string, number> = {}
		let wall = 0
		const m = await measured(options.serverPid, async () => {
			for (let r = 0; r < options.rounds; r++) {
				const started = performance.now()
				await Promise.all(tokens.map((_, i) => refresh(i, latencies, statuses)))
				wall += performance.now() - started
			}
		})
		phases.push(phase(`burst x${options.families}`, latencies, statuses, wall, m))
	}

	// Sustained: closed loop.
	{
		const latencies: number[] = []
		const statuses: Record<string, number> = {}
		const started = performance.now()
		const endAt = started + options.durationS * 1000
		const m = await measured(options.serverPid, async () => {
			await Promise.all(
				Array.from({ length: options.concurrency }, async (_, w) => {
					for (let k = w; performance.now() < endAt; k += options.concurrency)
						await refresh(k % tokens.length, latencies, statuses)
				}),
			)
		})
		phases.push(
			phase(
				`sustained c${options.concurrency}`,
				latencies,
				statuses,
				performance.now() - started,
				m,
			),
		)
	}

	// Duplicate: one token, many concurrent uses.
	const shared = tokens[0]!
	const latencies: number[] = []
	const statuses: Record<string, number> = {}
	const started = performance.now()
	const results: { status: number; token?: string }[] = []
	const m = await measured(options.serverPid, async () => {
		await Promise.all(
			Array.from({ length: options.duplicates }, async () => {
				const s = performance.now()
				const res = await client.refresh(shared)
				latencies.push(performance.now() - s)
				statuses[res.status] = (statuses[res.status] ?? 0) + 1
				results.push({ status: res.status, token: res.body.refresh_token })
			}),
		)
	})
	phases.push(
		phase(`duplicate x${options.duplicates}`, latencies, statuses, performance.now() - started, m),
	)
	const ok = results.filter((r) => r.status === 200)
	const next = ok[0]?.token
	const alive = next ? (await client.refresh(next)).status === 200 : false
	return {
		families: options.families,
		setupMs,
		phases,
		duplicate: {
			sent: options.duplicates,
			ok: ok.length,
			rejected: results.length - ok.length,
			distinctTokens: new Set(ok.map((r) => r.token)).size,
			familyAlive: alive,
		},
	}
}
