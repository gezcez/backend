// telemetry.module.ts

import { Module } from "@nestjs/common"
import { TelemetryController } from "./telemetry.controller"
import { TelemetryRepository } from "./telemetry.repository"
import { TelemetryService } from "./telemetry.service"

@Module({
	controllers: [TelemetryController],
	providers: [TelemetryRepository, TelemetryService],
	exports: [TelemetryRepository],
})
export class TelemetryModule {}
