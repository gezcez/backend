// analytics.repository.ts
// transit.db reads for analytics: the active catalogue routes of a set of bindings, loaded into
// the per-request `routes` view (adherence, coverage, quality score).

import { Injectable } from "@nestjs/common"
import { and, eq, inArray } from "drizzle-orm"
import { InjectTransitDb, type TransitDatabase } from "@db"
import { activeVersionsTable, routesTable } from "@schemas/transit"

export interface CatalogRoute {
	binding_id: number
	route_ext: string
	short_name: string
}

@Injectable()
export class AnalyticsRepository {
	constructor(@InjectTransitDb() private readonly db: TransitDatabase) {}

	activeRoutes(bindingIds: number[]): CatalogRoute[] {
		if (!bindingIds.length) return []
		return this.db
			.select({
				binding_id: routesTable.binding_id,
				route_ext: routesTable.external_id,
				short_name: routesTable.short_name,
			})
			.from(routesTable)
			.innerJoin(
				activeVersionsTable,
				and(
					eq(activeVersionsTable.binding_id, routesTable.binding_id),
					eq(activeVersionsTable.version_id, routesTable.version_id),
				),
			)
			.where(inArray(routesTable.binding_id, bindingIds))
			.all()
	}
}
