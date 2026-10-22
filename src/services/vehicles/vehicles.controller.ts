// vehicles.controller.ts
// Public live endpoints (plan 7.4): network vehicle snapshot (REST fallback of the WS channel),
// vehicle detail, stop departures and observed departures last week.

import { Controller, Get, Header, Param, Query } from "@nestjs/common"
import { ApiTags } from "@nestjs/swagger"
import { ApiEnvelope, Public } from "@common/middlewares"
import {
	DeparturesDto,
	DeparturesQueryDto,
	HistoryDeparturesDto,
	HistoryQueryDto,
	VehicleDetailDto,
	VehicleSnapshotDto,
	VehiclesQueryDto,
} from "./vehicles.dto"
import { VehiclesService } from "./vehicles.service"

@ApiTags("transit: live")
@Public()
@Controller()
export class VehiclesController {
	constructor(private readonly vehicles: VehiclesService) {}

	@Get("networks/:networkId/vehicles")
	@Header("Cache-Control", "public, max-age=5")
	@ApiEnvelope(VehicleSnapshotDto, {
		description:
			"Live vehicles as compact arrays in the order of `fields` (same as the WS snapshot)",
	})
	snapshot(@Param("networkId") networkId: string, @Query() query: VehiclesQueryDto) {
		return this.vehicles.snapshot({
			network: networkId,
			routes: query.routes,
			direction: query.direction as 0 | 1 | undefined,
			bbox: query.bbox,
		})
	}

	@Get("vehicles/:vehicleId")
	@Header("Cache-Control", "public, max-age=5")
	@ApiEnvelope(VehicleDetailDto, { description: "Live state, current run and runs today" })
	vehicle(@Param("vehicleId") vehicleId: string) {
		return this.vehicles.vehicleDetail(vehicleId)
	}

	@Get("stops/:stopId/departures")
	@Header("Cache-Control", "public, max-age=15")
	@ApiEnvelope(DeparturesDto, { description: "Scheduled departures merged with live vehicles" })
	departures(@Param("stopId") stopId: string, @Query() query: DeparturesQueryDto) {
		return this.vehicles.departures(stopId, query.limit)
	}

	@Get("routes/:routeId/history/departures")
	@Header("Cache-Control", "public, max-age=3600")
	@ApiEnvelope(HistoryDeparturesDto, {
		description: "Observed trip starts on the same weekday last week",
	})
	history(@Param("routeId") routeId: string, @Query() query: HistoryQueryDto) {
		return this.vehicles.historyDepartures(routeId, query)
	}
}
