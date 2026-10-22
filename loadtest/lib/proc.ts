// lib/proc.ts
// Samples CPU and memory of a process from /proc (Linux). CPU is the share of one core
// (100% = one core busy), summed over all threads, so the tracker Worker counts too.

import fs from "node:fs"

const CLOCK_TICKS = 100

export interface ProcSummary {
	pid: number
	durationS: number
	/** Average CPU over the window, % of one core. */
	cpuAvgPct: number
	/** Highest CPU over any sampling interval, % of one core. */
	cpuPeakPct: number
	rssStartMb: number
	rssEndMb: number
	rssPeakMb: number
}

function cpuTicks(pid: number): number {
	const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
	// Fields after the command name (which may contain spaces) start after the last ")".
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
	return Number(fields[11]) + Number(fields[12])
}

function rssMb(pid: number): number {
	const status = fs.readFileSync(`/proc/${pid}/status`, "utf8")
	const match = /VmRSS:\s+(\d+) kB/.exec(status)
	return match ? Number(match[1]) / 1024 : Number.NaN
}

export function procAvailable(pid: number): boolean {
	return fs.existsSync(`/proc/${pid}/stat`)
}

export class ProcSampler {
	private timer: ReturnType<typeof setInterval> | undefined
	private startAt = 0
	private startTicks = 0
	private lastAt = 0
	private lastTicks = 0
	private peakCpu = 0
	private rssStart = 0
	private rssPeak = 0

	constructor(
		readonly pid: number,
		private readonly intervalMs = 500,
	) {}

	start(): void {
		this.startAt = this.lastAt = performance.now()
		this.startTicks = this.lastTicks = cpuTicks(this.pid)
		this.rssStart = this.rssPeak = rssMb(this.pid)
		this.peakCpu = 0
		this.timer = setInterval(() => this.sample(), this.intervalMs)
	}

	private sample(): void {
		try {
			const now = performance.now()
			const ticks = cpuTicks(this.pid)
			const pct = ((ticks - this.lastTicks) / CLOCK_TICKS / ((now - this.lastAt) / 1000)) * 100
			this.peakCpu = Math.max(this.peakCpu, pct)
			this.lastAt = now
			this.lastTicks = ticks
			this.rssPeak = Math.max(this.rssPeak, rssMb(this.pid))
		} catch {
			// The process exited; stop() reports what was seen.
		}
	}

	stop(): ProcSummary {
		if (this.timer) clearInterval(this.timer)
		this.sample()
		const durationS = (this.lastAt - this.startAt) / 1000
		const rssEnd = (() => {
			try {
				return rssMb(this.pid)
			} catch {
				return Number.NaN
			}
		})()
		return {
			pid: this.pid,
			durationS,
			cpuAvgPct: durationS
				? ((this.lastTicks - this.startTicks) / CLOCK_TICKS / durationS) * 100
				: Number.NaN,
			cpuPeakPct: this.peakCpu,
			rssStartMb: this.rssStart,
			rssEndMb: rssEnd,
			rssPeakMb: Math.max(this.rssPeak, rssEnd || 0),
		}
	}
}

/** Runs `fn` while sampling the server (and this load generator) process. */
export async function measured<T>(
	serverPid: number | undefined,
	fn: () => Promise<T>,
): Promise<{ result: T; server?: ProcSummary; client: ProcSummary }> {
	const server =
		serverPid && procAvailable(serverPid) ? new ProcSampler(serverPid) : undefined
	const client = new ProcSampler(process.pid)
	server?.start()
	client.start()
	const result = await fn()
	return { result, server: server?.stop(), client: client.stop() }
}
