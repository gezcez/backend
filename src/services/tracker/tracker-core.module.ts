// tracker-core.module.ts
// The tracker engine without HTTP. Imported by the worker (MODE=all), by the main app for
// MODE=tracker and TRACKER_RUNNER=inline|manual. Needs the global Database, Providers and
// NetworksCore modules.

import { Module } from "@nestjs/common"
import { TransitRepository } from "@services/transit/transit.repository"
import { TrackerRepository } from "./tracker.repository"
import { TrackerService } from "./tracker.service"
import { TrackerTimetable } from "./tracker-timetable"

@Module({
	providers: [TrackerRepository, TrackerService, TrackerTimetable, TransitRepository],
	exports: [TrackerService, TrackerRepository],
})
export class TrackerCoreModule {}
