import { describe, expect, test } from "bun:test"
import { UpstreamLimiter } from "./upstream-limiter"

/** A clock that only moves when the limiter sleeps. */
function fakeClock() {
	let now = 1_000_000
	const sleeps: number[] = []
	return {
		now: () => now,
		sleep: async (ms: number) => {
			sleeps.push(ms)
			now += ms
		},
		advance: (ms: number) => {
			now += ms
		},
		sleeps,
	}
}

function deferred<T = void>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((r) => (resolve = r))
	return { promise, resolve }
}

describe("UpstreamLimiter token bucket", () => {
	test("the first request per host is free, the next ones wait 1/rps", async () => {
		const clock = fakeClock()
		const limiter = new UpstreamLimiter({ maxInFlight: 4, defaultRps: 2, ...clock })
		for (let i = 0; i < 3; i++) await limiter.run("a.example", async () => i)
		expect(clock.sleeps).toEqual([500, 500])
	})

	test("hosts have separate buckets", async () => {
		const clock = fakeClock()
		const limiter = new UpstreamLimiter({ maxInFlight: 4, defaultRps: 1, ...clock })
		await limiter.run("a.example", async () => 1)
		await limiter.run("b.example", async () => 1)
		expect(clock.sleeps).toEqual([])
	})

	test("setHostRate overrides the default rate for one host", async () => {
		const clock = fakeClock()
		const limiter = new UpstreamLimiter({ maxInFlight: 4, defaultRps: 1, ...clock })
		limiter.setHostRate("slow.example", 0.25)
		await limiter.run("slow.example", async () => 1)
		await limiter.run("slow.example", async () => 1)
		expect(clock.sleeps).toEqual([4000])
	})

	test("tokens refill with time up to the burst capacity", async () => {
		const clock = fakeClock()
		const limiter = new UpstreamLimiter({ maxInFlight: 4, defaultRps: 2, ...clock })
		await limiter.run("a.example", async () => 1)
		clock.advance(60_000)
		// Capacity is max(1, rps) = 2 tokens, so two are free after a long idle period.
		await limiter.run("a.example", async () => 1)
		await limiter.run("a.example", async () => 1)
		expect(clock.sleeps).toEqual([])
		await limiter.run("a.example", async () => 1)
		expect(clock.sleeps).toEqual([500])
	})

	test("an aborted signal stops the wait for a token", async () => {
		const clock = fakeClock()
		const controller = new AbortController()
		const limiter = new UpstreamLimiter({
			maxInFlight: 4,
			defaultRps: 1,
			now: clock.now,
			sleep: async (ms) => {
				await clock.sleep(ms)
				controller.abort(new Error("stop"))
			},
		})
		await limiter.run("a.example", async () => 1)
		await expect(limiter.run("a.example", async () => 1, controller.signal)).rejects.toThrow(
			"stop",
		)
		expect(limiter.active).toBe(0)
	})
})

describe("UpstreamLimiter concurrency", () => {
	test("queues tasks beyond maxInFlight and runs them in order", async () => {
		const limiter = new UpstreamLimiter({ maxInFlight: 2, defaultRps: 1e9 })
		const gates = [deferred(), deferred(), deferred()]
		const order: number[] = []
		const runs = gates.map((gate, i) =>
			limiter.run("a.example", async () => {
				order.push(i)
				await gate.promise
				return i
			}),
		)
		await Bun.sleep(5)
		expect(limiter.active).toBe(2)
		expect(order).toEqual([0, 1])
		gates[0]!.resolve()
		await Bun.sleep(5)
		expect(order).toEqual([0, 1, 2])
		expect(limiter.active).toBe(2)
		gates[1]!.resolve()
		gates[2]!.resolve()
		expect(await Promise.all(runs)).toEqual([0, 1, 2])
		expect(limiter.active).toBe(0)
	})

	test("releases the slot when the task throws", async () => {
		const limiter = new UpstreamLimiter({ maxInFlight: 1, defaultRps: 1e9 })
		await expect(
			limiter.run("a.example", async () => {
				throw new Error("boom")
			}),
		).rejects.toThrow("boom")
		expect(limiter.active).toBe(0)
		expect(await limiter.run("a.example", async () => "ok")).toBe("ok")
	})

	test("an abort while queued leaves the queue without taking a slot", async () => {
		const limiter = new UpstreamLimiter({ maxInFlight: 1, defaultRps: 1e9 })
		const gate = deferred()
		const first = limiter.run("a.example", () => gate.promise)
		const controller = new AbortController()
		let ran = false
		const queued = limiter.run(
			"a.example",
			async () => {
				ran = true
			},
			controller.signal,
		)
		controller.abort(new Error("cancelled"))
		await expect(queued).rejects.toThrow("cancelled")
		gate.resolve()
		await first
		expect(ran).toBe(false)
		expect(limiter.active).toBe(0)
		// The queue is empty: the next task gets the slot at once.
		expect(await limiter.run("a.example", async () => "next")).toBe("next")
	})

	test("an already aborted signal fails before queueing", async () => {
		const limiter = new UpstreamLimiter({ maxInFlight: 1, defaultRps: 1e9 })
		const controller = new AbortController()
		controller.abort(new Error("early"))
		await expect(limiter.run("a.example", async () => 1, controller.signal)).rejects.toThrow(
			"early",
		)
		expect(limiter.active).toBe(0)
	})
})
