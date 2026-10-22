// system.module.ts

import { Global, Module } from "@nestjs/common"
import { SystemController } from "./system.controller"
import { SystemRepository } from "./system.repository"
import { SystemService } from "./system.service"

@Global()
@Module({
	controllers: [SystemController],
	providers: [SystemService, SystemRepository],
	exports: [SystemService],
})
export class SystemModule {}
