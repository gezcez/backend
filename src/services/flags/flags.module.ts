// flags.module.ts
// Global: any service can read flags and settings.

import { Global, Module } from "@nestjs/common"
import { FlagsController, SystemNoticeController } from "./flags.controller"
import { FlagsRepository } from "./flags.repository"
import { FlagsService } from "./flags.service"

@Global()
@Module({
	controllers: [FlagsController, SystemNoticeController],
	providers: [FlagsService, FlagsRepository],
	exports: [FlagsService],
})
export class FlagsModule {}
