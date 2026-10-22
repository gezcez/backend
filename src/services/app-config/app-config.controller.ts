// app-config.controller.ts

import { Controller, Get, Header, Query } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { ApiEnvelope, Public } from "@common/middlewares"
import { AppConfigDto, AppConfigQueryDto } from "./app-config.dto"
import { AppConfigService } from "./app-config.service"

@ApiTags("app")
@Public()
@Controller("app")
export class AppConfigController {
	constructor(private readonly appConfig: AppConfigService) {}

	@Get("config")
	@Header("Cache-Control", "public, max-age=300")
	@ApiOperation({
		summary:
			"Remote config: update versions, flags, kill switches, announcement, tiles, WS URL",
	})
	@ApiEnvelope(AppConfigDto)
	config(@Query() query: AppConfigQueryDto): AppConfigDto {
		return this.appConfig.config(query)
	}
}
