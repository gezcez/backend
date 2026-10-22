// scenarios/ws.ts
// WebSocket fan-out: N anonymous clients subscribe to the vehicles channel of one network while
// the tracker polls the (replayed) binding. Measures connect and snapshot latency, then over a
// window the messages and bytes delivered per second and how long one feed takes to reach every
// client. Frames are not JSON-parsed on the client (only the header fields are read), so the load
// generator spends its CPU on the socket, not on parsing.

import { measured, type ProcSummary } from "../lib/proc"
import { summarize, type LatencySummary } from "../lib/stats"

export interface WsOptions {
	baseUrl: string
	serverPid?: number
	clients: number
	networkId: number
	windowS: number
	/** Sockets opened at the same time while connecting. */
	connectBatch: number
}

export interface WsResult {
	clients: number
	connected: number
	subscribed: number
	closedDuringWindow: number
	connectMs: LatencySummary
	snapshotMs: LatencySummary
	snapshotBytes: number
	windowS: number
	messages: number
	msgsPerS: number
	mbPerS: number
	deltas: number
	/** Feeds seen in the window and how many clients got each. */
	feeds: { feedTs: number; clients: number; spreadMs: number }[]
	/** Arrival minus first arrival of the same feed, ms. */
	spreadMs: LatencySummary
	/** Arrival minus the feed timestamp (whole seconds, so up to 1 s coarse), ms. */
	feedLagMs: LatencySummary
	avgDeltaBytes: number
	serverConnect?: ProcSummary
	serverWindow?: ProcSummary
	clientWindow: ProcSummary
	serverRssIdleMb?: number
}

const HEADER = /"type":"(\w+)"(?:,"sub":"[^"]*","seq":\d+,"feed_ts":(\d+|null))?/
const PING = /^\{"type":"ping","t":(\d+)\}$/

interface Conn {
	ws: WebSocket
	openedAt: number
	snapshotAt: number
	closed: boolean
}

export async function wsScenario(options: WsOptions): Promise<WsResult> {
	const wsUrl = options.baseUrl.replace(/^http/, "ws") + "/v1/ws"
	const conns: Conn[] = []
	const connectMs: number[] = []
	const snapshotMs: number[] = []
	let snapshotBytes = 0
	let recording = false
	let closedDuringWindow = 0
	let messages = 0
	let bytes = 0
	let deltaBytes = 0
	let deltas = 0
	const arrivals = new Map<number, number[]>()

	const open = (index: number) =>
		new Promise<Conn>((resolve, reject) => {
			const started = performance.now()
			// Bun's WebSocket takes headers; the server trusts CF-Connecting-IP in this run,
			// which keeps the per-IP socket limit (10) from capping the test.
			const ws = new WebSocket(wsUrl, {
				headers: { "cf-connecting-ip": `10.2.${(index >> 8) & 255}.${index & 255}` },
			} as unknown as string[])
			const conn: Conn = { ws, openedAt: 0, snapshotAt: 0, closed: false }
			let subscribeAt = 0
			const timeout = setTimeout(() => reject(new Error("connect timeout")), 30_000)
			ws.onopen = () => {
				conn.openedAt = performance.now()
				connectMs.push(conn.openedAt - started)
				subscribeAt = performance.now()
				ws.send(
					JSON.stringify({
						type: "subscribe",
						id: "v",
						channel: "vehicles",
						params: { network: options.networkId },
					}),
				)
			}
			ws.onmessage = (event) => {
				const data = event.data as string
				const now = performance.now()
				const head = HEADER.exec(data.slice(0, 120))
				const type = head?.[1]
				if (type === "ping") {
					const t = PING.exec(data)?.[1]
					ws.send(JSON.stringify({ type: "pong", t: t ? Number(t) : undefined }))
					return
				}
				if (type === "snapshot" && !conn.snapshotAt) {
					conn.snapshotAt = now
					snapshotMs.push(now - subscribeAt)
					snapshotBytes = Math.max(snapshotBytes, data.length)
					clearTimeout(timeout)
					resolve(conn)
				}
				if (!recording) return
				messages++
				bytes += data.length
				if (type === "delta" && head?.[2] && head[2] !== "null") {
					deltas++
					deltaBytes += data.length
					const feedTs = Number(head[2])
					const list = arrivals.get(feedTs) ?? []
					list.push(Date.now())
					arrivals.set(feedTs, list)
				}
			}
			ws.onclose = () => {
				if (recording && !conn.closed) closedDuringWindow++
				conn.closed = true
				clearTimeout(timeout)
				reject(new Error("closed before snapshot"))
			}
			ws.onerror = () => undefined
		})

	const connectPhase = await measured(options.serverPid, async () => {
		for (let i = 0; i < options.clients; i += options.connectBatch) {
			const batch = Array.from(
				{ length: Math.min(options.connectBatch, options.clients - i) },
				(_, j) => open(i + j),
			)
			for (const result of await Promise.allSettled(batch))
				if (result.status === "fulfilled") conns.push(result.value)
		}
	})

	// Start the window at a feed boundary-independent point and let at least a few polls land.
	recording = true
	const windowPhase = await measured(options.serverPid, async () => {
		await Bun.sleep(options.windowS * 1000)
	})
	recording = false

	const feeds = [...arrivals.entries()]
		.sort(([a], [b]) => a - b)
		.map(([feedTs, times]) => {
			const first = Math.min(...times)
			return { feedTs, clients: times.length, spreadMs: Math.max(...times) - first }
		})
	const spreads: number[] = []
	const lags: number[] = []
	for (const [feedTs, times] of arrivals) {
		const first = Math.min(...times)
		for (const t of times) {
			spreads.push(t - first)
			lags.push(t - feedTs * 1000)
		}
	}
	for (const conn of conns) conn.ws.close()
	await Bun.sleep(500)
	return {
		clients: options.clients,
		connected: connectMs.length,
		subscribed: conns.length,
		closedDuringWindow,
		connectMs: summarize(connectMs),
		snapshotMs: summarize(snapshotMs),
		snapshotBytes,
		windowS: options.windowS,
		messages,
		msgsPerS: messages / options.windowS,
		mbPerS: bytes / 1048576 / options.windowS,
		deltas,
		feeds,
		spreadMs: summarize(spreads),
		feedLagMs: summarize(lags),
		avgDeltaBytes: deltas ? deltaBytes / deltas : 0,
		serverConnect: connectPhase.server,
		serverWindow: windowPhase.server,
		clientWindow: windowPhase.client,
	}
}
