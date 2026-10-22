// transit.module.ts

import { Module } from "@nestjs/common"
import { TransitAdminController } from "./transit-admin.controller"
import { TransitController } from "./transit.controller"
import { TransitRepository } from "./transit.repository"
import { TransitService } from "./transit.service"
import { TransitSyncService } from "./transit-sync.service"

@Module({
	controllers: [TransitController, TransitAdminController],
	providers: [TransitRepository, TransitService, TransitSyncService],
	exports: [TransitService, TransitSyncService, TransitRepository],
})
export class TransitModule {}
