// analytics.module.ts
// DuckDB analytics over the Parquet archive and hot vts.db rows (plan 6.9): the dashboard
// metric and export endpoints, and the public aggregates. Needs the global DuckDbModule and ArchiveModule.

import { Module } from "@nestjs/common"
import { AnalyticsController } from "./analytics.controller"
import { AnalyticsRepository } from "./analytics.repository"
import { AnalyticsService } from "./analytics.service"
import { PublicAnalyticsController } from "./public-analytics.controller"
import { PublicAnalyticsService } from "./public-analytics.service"

@Module({
	controllers: [AnalyticsController, PublicAnalyticsController],
	providers: [AnalyticsRepository, AnalyticsService, PublicAnalyticsService],
	exports: [AnalyticsService],
})
export class AnalyticsModule {}
