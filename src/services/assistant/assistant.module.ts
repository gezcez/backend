// assistant.module.ts
// Trip assistant (mobile plan L3, backend plan 6.17). Off by default; see docs/assistant.md.

import { Module } from "@nestjs/common"
import { AppConfigModule } from "@services/app-config/app-config.module"
import { TransitModule } from "@services/transit/transit.module"
import { VehiclesModule } from "@services/vehicles/vehicles.module"
import { AnthropicClient } from "./anthropic.client"
import { AssistantController } from "./assistant.controller"
import { AssistantService } from "./assistant.service"
import { AssistantTools } from "./assistant.tools"

@Module({
	imports: [AppConfigModule, TransitModule, VehiclesModule],
	controllers: [AssistantController],
	providers: [AnthropicClient, AssistantService, AssistantTools],
	exports: [AssistantService],
})
export class AssistantModule {}
