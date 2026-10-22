// system.controller.ts
// /health and /ready sit outside the /v1 prefix and the envelope, for probes and load balancers.

import { Controller, Get, Res } from "@nestjs/common"
import { ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { SkipThrottle } from "@nestjs/throttler"
import { ApiEnvelope, Public, RawResponse } from "@common/middlewares"
import { HealthDto, ReadyDto, VersionDto } from "./system.dto"
import { SystemService } from "./system.service"

@ApiTags("system")
@Public()
@SkipThrottle()
@Controller()
export class SystemController {
	constructor(private readonly service: SystemService) {}

	@Get("health")
	@RawResponse()
	@ApiEnvelope(HealthDto, { raw: true })
	health(): HealthDto {
		return { status: "ok" }
	}

	@Get("ready")
	@RawResponse()
	@ApiEnvelope(ReadyDto, { raw: true, description: "503 when any check fails" })
	async ready(@Res({ passthrough: true }) res: Response): Promise<ReadyDto> {
		const result = await this.service.readiness()
		if (!result.ready) res.status(503)
		return result
	}

	@Get("system/version")
	@ApiEnvelope(VersionDto)
	version(): VersionDto {
		return this.service.version()
	}
}
