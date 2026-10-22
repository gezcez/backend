// job-events.bus.ts
// In-process job lifecycle events for the `jobs` WS channel (plan 6.10): a run starts, then
// finishes as succeeded or failed. Jobs report here (static sync today; retention, archive and
// the scheduled jobs page join when the jobs service lands). Keeps the last runs for snapshots.

import { Injectable } from "@nestjs/common"

export type JobRunState = "running" | "succeeded" | "failed"

export interface JobRunEvent {
	/** Process-local run id. */
	id: number
	job: string
	trigger: string
	state: JobRunState
	started_at: string
	finished_at: string | null
	duration_ms: number | null
	/** Small job-specific context (binding id, counts, error message). */
	detail: Record<string, unknown>
}

export interface JobRunHandle {
	finish(state: Exclude<JobRunState, "running">, detail?: Record<string, unknown>): void
}

const KEEP = 50

@Injectable()
export class JobEventsBus {
	private nextId = 1
	private readonly runs: JobRunEvent[] = []
	private readonly listeners = new Set<(event: JobRunEvent) => void>()

	subscribe(listener: (event: JobRunEvent) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	/** Running jobs and the last finished runs, newest first. */
	recent(): JobRunEvent[] {
		return [...this.runs].reverse().map((r) => ({ ...r, detail: { ...r.detail } }))
	}

	start(job: string, trigger: string, detail: Record<string, unknown> = {}): JobRunHandle {
		const started = Date.now()
		const run: JobRunEvent = {
			id: this.nextId++,
			job,
			trigger,
			state: "running",
			started_at: new Date(started).toISOString(),
			finished_at: null,
			duration_ms: null,
			detail,
		}
		this.runs.push(run)
		if (this.runs.length > KEEP) this.runs.splice(0, this.runs.length - KEEP)
		this.emit(run)
		let done = false
		return {
			finish: (state, extra = {}) => {
				if (done) return
				done = true
				const finished = Date.now()
				run.state = state
				run.finished_at = new Date(finished).toISOString()
				run.duration_ms = finished - started
				run.detail = { ...run.detail, ...extra }
				this.emit(run)
			},
		}
	}

	private emit(run: JobRunEvent): void {
		const event = { ...run, detail: { ...run.detail } }
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch {
				// A listener failure never breaks the job.
			}
		}
	}
}
