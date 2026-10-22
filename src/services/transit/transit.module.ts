// transit.module.ts

import { Module } from "@nestjs/common"
import { AlertsService } from "./alerts.service"
import { PackController } from "./pack.controller"
import { PackService } from "./pack.service"
import { TransitAdminController } from "./transit-admin.controller"
import { TransitController } from "./transit.controller"
import { TransitRepository } from "./transit.repository"
import { TransitService } from "./transit.service"
import { TransitSyncService } from "./transit-sync.service"

@Module({
	controllers: [TransitController, TransitAdminController, PackController],
	providers: [TransitRepository, TransitService, TransitSyncService, PackService, AlertsService],
	exports: [TransitService, TransitSyncService, TransitRepository, PackService],
})
export class TransitModule {}
