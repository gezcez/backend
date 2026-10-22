// ws.module.ts
// Realtime gateway at /v1/ws (plan 6.10).

import { Module } from "@nestjs/common"
import { VehiclesModule } from "@services/vehicles/vehicles.module"
import { RealtimeGateway } from "./realtime.ws"

@Module({
	imports: [VehiclesModule],
	providers: [RealtimeGateway],
	exports: [RealtimeGateway],
})
export class WsModule {}
