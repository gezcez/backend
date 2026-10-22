// app-config.module.ts

import { Module } from "@nestjs/common"
import { AppConfigController } from "./app-config.controller"
import { AppConfigRepository } from "./app-config.repository"
import { AppConfigService } from "./app-config.service"

@Module({
	controllers: [AppConfigController],
	providers: [AppConfigRepository, AppConfigService],
	exports: [AppConfigService],
})
export class AppConfigModule {}
