// vehicles.controller.ts
// Public live endpoints (plan 7.4): network vehicle snapshot (REST fallback of the WS channel),
// vehicle detail, stop departures and observed departures last week.

import { Controller, Get, Header, Headers, Param, Query, Res } from "@nestjs/common"
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
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
	@ApiBearerAuth("bearer")
	@ApiEnvelope(VehicleSnapshotDto, {
		description:
			"Live vehicles as arrays in the order of `fields` (same as the WS snapshot). Public for compact rows; detail=full needs a dash token with vehicles.live.read",
	})
	async snapshot(
		@Param("networkId") networkId: string,
		@Query() query: VehiclesQueryDto,
		@Headers("authorization") authorization: string | undefined,
		@Res({ passthrough: true }) res: Response,
	) {
		const snapshot = await this.vehicles.snapshot(
			{
				network: networkId,
				routes: query.routes,
				direction: query.direction as 0 | 1 | undefined,
				bbox: query.bbox,
			},
			query.detail,
			authorization,
		)
		res.setHeader(
			"Cache-Control",
			query.detail === "full" ? "private, no-store" : "public, max-age=5",
		)
		return snapshot
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
