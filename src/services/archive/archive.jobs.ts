// archive.jobs.ts
// Daily schedules of the process that owns vts.db (plan 8.8 and 6.9), local Europe/Istanbul:
// the Parquet export at ARCHIVE_EXPORT_AT (03:30) and the aggregates at AGGREGATES_AT (04:30).
// Timers are unref'd and re-armed after each run; "off" disables a schedule.

import {
	Injectable,
	Logger,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common"
import { InjectConfig, type AppConfig } from "@common/config"
import { localTime } from "@common/utils"
import { AggregatesJob } from "@services/analytics/aggregates.jobs"
import { ArchiveService } from "./archive.service"

const SCHEDULE_TZ = "Europe/Istanbul"

export interface JobSchedule {
	key: "archive.export" | "analytics.aggregates"
	next_run_at: number | null
}

@Injectable()
export class ArchiveJobs implements OnApplicationBootstrap, OnApplicationShutdown {
	private readonly logger = new Logger("ArchiveJobs")
	private readonly timers = new Map<JobSchedule["key"], ReturnType<typeof setTimeout>>()
	private readonly next = new Map<JobSchedule["key"], number>()
	private stopped = false

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly archive: ArchiveService,
		private readonly aggregates: AggregatesJob,
	) {}

	onApplicationBootstrap(): void {
		if (!this.archive.canWrite) return
		const { exportAt, aggregatesAt } = this.config.analytics
		if (exportAt !== null)
			this.schedule("archive.export", exportAt, () => this.archive.runNightly())
		if (aggregatesAt !== null)
			this.schedule("analytics.aggregates", aggregatesAt, () => this.aggregates.run())
	}

	schedules(): JobSchedule[] {
		return (["archive.export", "analytics.aggregates"] as const).map((key) => ({
			key,
			next_run_at: this.next.get(key) ?? null,
		}))
	}

	private schedule(key: JobSchedule["key"], at: number, run: () => Promise<unknown>): void {
		const now = Math.floor(Date.now() / 1000)
		let wait = at - localTime(now, SCHEDULE_TZ).secondsOfDay
		if (wait <= 0) wait += 86400
		this.next.set(key, now + wait)
		const timer = setTimeout(() => {
			run()
				.catch((error: unknown) =>
					this.logger.error(`${key} failed: ${(error as Error).message}`),
				)
				.finally(() => {
					if (!this.stopped) this.schedule(key, at, run)
				})
		}, wait * 1000)
		timer.unref?.()
		this.timers.set(key, timer)
	}

	onApplicationShutdown(): void {
		this.stopped = true
		for (const timer of this.timers.values()) clearTimeout(timer)
	}
}
