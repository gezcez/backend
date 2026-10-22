// cities.module.ts

import { Module } from "@nestjs/common"
import { TransitModule } from "@services/transit/transit.module"
import { CitiesController } from "./cities.controller"
import { CitiesService } from "./cities.service"

@Module({
	imports: [TransitModule],
	controllers: [CitiesController],
	providers: [CitiesService],
})
export class CitiesModule {}
