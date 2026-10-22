// keys.module.ts
// Global so the authentication guard can verify tokens anywhere.

import { Global, Module } from "@nestjs/common"
import { KeysRepository } from "./keys.repository"
import { KeysService } from "./keys.service"
import { WellKnownController } from "./well-known.controller"

@Global()
@Module({
	controllers: [WellKnownController],
	providers: [KeysService, KeysRepository],
	exports: [KeysService],
})
export class KeysModule {}
