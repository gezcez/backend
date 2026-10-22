// telemetry.controller.ts
// POST /v1/telemetry/counters (public, 10 per IP per hour).

import { Body, Controller, HttpCode, Post } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { ApiEnvelope, Public, RateLimit } from "@common/middlewares"
import { TelemetryAcceptedDto, TelemetryCountersDto } from "./telemetry.dto"
import { TelemetryService } from "./telemetry.service"

@ApiTags("telemetry")
@Public()
@Controller("telemetry")
export class TelemetryController {
	constructor(private readonly telemetry: TelemetryService) {}

	@Post("counters")
	@HttpCode(200)
	@RateLimit("telemetry")
	@ApiOperation({ summary: "Add a day's aggregate app counters (no identifiers)" })
	@ApiEnvelope(TelemetryAcceptedDto)
	counters(@Body() body: TelemetryCountersDto): TelemetryAcceptedDto {
		return this.telemetry.record(body)
	}
}
