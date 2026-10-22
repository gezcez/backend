// networks.module.ts
// Dashboard catalog endpoints on top of NetworksCoreModule (global, shared with the tracker).

import { Module } from "@nestjs/common"
import { NetworksAdminService } from "./networks-admin.service"
import { NetworksCoreModule } from "./networks-core.module"
import { NetworksController } from "./networks.controller"

@Module({
	imports: [NetworksCoreModule],
	controllers: [NetworksController],
	providers: [NetworksAdminService],
})
export class NetworksModule {}
