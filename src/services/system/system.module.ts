// system.module.ts

import { Global, Module } from "@nestjs/common"
import { JobEventsBus } from "./job-events.bus"
import { SystemController } from "./system.controller"
import { SystemRepository } from "./system.repository"
import { SystemService } from "./system.service"

@Global()
@Module({
	controllers: [SystemController],
	providers: [SystemService, SystemRepository, JobEventsBus],
	exports: [SystemService, JobEventsBus],
})
export class SystemModule {}
