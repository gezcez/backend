// tracker.module.ts
// API-side tracker wiring: the host (worker, inline engine or MODE=api change feed), the
// LiveFeedBus and the dashboard tracker endpoints. Global because the realtime gateway and the
// vehicle endpoints read the bus.

import { Global, Module, type DynamicModule } from "@nestjs/common"
import type { AppConfig } from "@common/config"
import { LiveFeedBus } from "./live-feed.bus"
import { TrackerAdminController } from "./tracker-admin.controller"
import { TrackerCoreModule } from "./tracker-core.module"
import { TrackerHostService, trackerRunner } from "./tracker-host.service"
import { TrackerRepository } from "./tracker.repository"

@Global()
@Module({})
export class TrackerModule {
	static forRoot(config: AppConfig, options: { http: boolean } = { http: true }): DynamicModule {
		const runner = trackerRunner(config)
		return {
			module: TrackerModule,
			global: true,
			imports: runner === "inline" || runner === "manual" ? [TrackerCoreModule] : [],
			controllers: options.http ? [TrackerAdminController] : [],
			providers: [TrackerRepository, LiveFeedBus, TrackerHostService],
			exports: [LiveFeedBus, TrackerHostService, TrackerRepository],
		}
	}
}
