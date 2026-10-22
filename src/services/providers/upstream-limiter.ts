// upstream-limiter.ts
// Politeness towards upstreams (plan section 8.2): at most N requests in flight per process and a
// token bucket per host shared by the tracker and the static sync of the same process.

export interface UpstreamLimiterOptions {
	maxInFlight: number
	/** Default requests per second per host when a provider gives no hint. */
	defaultRps: number
	now?: () => number
	sleep?: (ms: number) => Promise<void>
}

interface Bucket {
	tokens: number
	rps: number
	updatedAt: number
}

export class UpstreamLimiter {
	private inFlight = 0
	private readonly waiters: (() => void)[] = []
	private readonly buckets = new Map<string, Bucket>()
	private readonly now: () => number
	private readonly sleep: (ms: number) => Promise<void>

	constructor(private readonly options: UpstreamLimiterOptions) {
		this.now = options.now ?? Date.now
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
	}

	setHostRate(host: string, rps: number): void {
		const bucket = this.bucket(host)
		bucket.rps = rps
	}

	get active(): number {
		return this.inFlight
	}

	/** Runs `task` once a concurrency slot and a host token are available. */
	async run<T>(host: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		await this.acquireSlot(signal)
		try {
			await this.takeToken(host, signal)
			return await task()
		} finally {
			this.releaseSlot()
		}
	}

	private bucket(host: string): Bucket {
		let bucket = this.buckets.get(host)
		if (!bucket) {
			bucket = { tokens: 1, rps: this.options.defaultRps, updatedAt: this.now() }
			this.buckets.set(host, bucket)
		}
		return bucket
	}

	private async takeToken(host: string, signal?: AbortSignal): Promise<void> {
		const bucket = this.bucket(host)
		for (;;) {
			signal?.throwIfAborted()
			const now = this.now()
			const capacity = Math.max(1, bucket.rps)
			bucket.tokens = Math.min(
				capacity,
				bucket.tokens + ((now - bucket.updatedAt) / 1000) * bucket.rps,
			)
			bucket.updatedAt = now
			if (bucket.tokens >= 1) {
				bucket.tokens -= 1
				return
			}
			await this.sleep(Math.ceil(((1 - bucket.tokens) / bucket.rps) * 1000))
		}
	}

	private acquireSlot(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted()
		if (this.inFlight < this.options.maxInFlight) {
			this.inFlight++
			return Promise.resolve()
		}
		return new Promise((resolve, reject) => {
			const grant = () => {
				signal?.removeEventListener("abort", onAbort)
				this.inFlight++
				resolve()
			}
			const onAbort = () => {
				const index = this.waiters.indexOf(grant)
				if (index >= 0) this.waiters.splice(index, 1)
				reject(signal?.reason ?? new Error("aborted"))
			}
			signal?.addEventListener("abort", onAbort, { once: true })
			this.waiters.push(grant)
		})
	}

	private releaseSlot(): void {
		this.inFlight--
		const next = this.waiters.shift()
		if (next) next()
	}
}
