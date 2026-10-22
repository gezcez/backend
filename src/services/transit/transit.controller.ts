// transit.controller.ts
// Public transit endpoints for the rider app, www and third parties (plan 7.4).

import { Controller, Get, Header, Param, Query } from "@nestjs/common"
import { ApiTags } from "@nestjs/swagger"
import { ApiEnvelope, Public } from "@common/middlewares"
import {
	AlertDto,
	DirectionQueryDto,
	NearbyDto,
	NearbyQueryDto,
	RouteDetailDto,
	RoutePageDto,
	RouteShapeDto,
	RoutesQueryDto,
	SearchQueryDto,
	SearchResultDto,
	StopDetailDto,
	StopPageDto,
	StopsQueryDto,
	TimetableDto,
	TimetableQueryDto,
} from "./transit.dto"
import { AlertsService } from "./alerts.service"
import { TransitService } from "./transit.service"

@ApiTags("transit")
@Public()
@Controller()
export class TransitController {
	constructor(
		private readonly transit: TransitService,
		private readonly alerts: AlertsService,
	) {}

	@Get("networks/:networkId/alerts")
	@Header("Cache-Control", "public, max-age=300")
	@ApiEnvelope([AlertDto], {
		description:
			"Active service alerts; an empty list unless the network has the alerts capability",
	})
	networkAlerts(@Param("networkId") networkId: string) {
		return this.alerts.list(networkId)
	}

	@Get("networks/:networkId/routes")
	@Header("Cache-Control", "public, max-age=600")
	@ApiEnvelope(RoutePageDto, {
		description: "Routes of a network (pagination when limit is set)",
	})
	routes(@Param("networkId") networkId: string, @Query() query: RoutesQueryDto) {
		return this.transit.listRoutes(networkId, query)
	}

	@Get("networks/:networkId/stops")
	@Header("Cache-Control", "public, max-age=600")
	@ApiEnvelope(StopPageDto, { description: "Stops of a network, optionally inside a bbox" })
	stops(@Param("networkId") networkId: string, @Query() query: StopsQueryDto) {
		return this.transit.listStops(networkId, query)
	}

	@Get("routes/:routeId")
	@Header("Cache-Control", "public, max-age=600")
	@ApiEnvelope(RouteDetailDto)
	route(@Param("routeId") routeId: string) {
		return this.transit.routeDetail(routeId)
	}

	@Get("routes/:routeId/shape")
	@Header("Cache-Control", "public, max-age=604800")
	@ApiEnvelope(RouteShapeDto, { description: "Encoded polylines (precision 6) per direction" })
	shape(@Param("routeId") routeId: string, @Query() query: DirectionQueryDto) {
		return this.transit.routeShape(routeId, query.direction)
	}

	@Get("routes/:routeId/timetable")
	@Header("Cache-Control", "public, max-age=600")
	@ApiEnvelope(TimetableDto, { description: "Timetable for a date or a day type" })
	timetable(@Param("routeId") routeId: string, @Query() query: TimetableQueryDto) {
		return this.transit.routeTimetable(routeId, query)
	}

	// Registered before stops/:stopId so "nearby" is not taken for an id. The request is excluded
	// from access logs and the coordinates are redacted (plan 6.11).
	@Get("stops/nearby")
	@Header("Cache-Control", "no-store")
	@ApiEnvelope(NearbyDto, { description: "Nearby stops; coordinates are never logged or stored" })
	nearby(@Query() query: NearbyQueryDto) {
		return this.transit.nearby(query)
	}

	@Get("stops/:stopId")
	@Header("Cache-Control", "public, max-age=600")
	@ApiEnvelope(StopDetailDto)
	stop(@Param("stopId") stopId: string) {
		return this.transit.stopDetail(stopId)
	}

	@Get("search")
	@Header("Cache-Control", "public, max-age=300")
	@ApiEnvelope(SearchResultDto, { description: "Routes and stops (FTS5, Turkish folding)" })
	search(@Query() query: SearchQueryDto) {
		return this.transit.search(query)
	}
}
