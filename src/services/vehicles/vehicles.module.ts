// vehicles.module.ts

import { Module } from "@nestjs/common"
import { TrackerTimetable } from "@services/tracker/tracker-timetable"
import { TransitModule } from "@services/transit/transit.module"
import { VehiclesController } from "./vehicles.controller"
import { VehiclesService } from "./vehicles.service"

@Module({
	imports: [TransitModule],
	controllers: [VehiclesController],
	providers: [VehiclesService, TrackerTimetable],
	exports: [VehiclesService],
})
export class VehiclesModule {}
