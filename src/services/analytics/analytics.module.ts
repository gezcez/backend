// analytics.module.ts
// DuckDB analytics over the Parquet archive and hot vts.db rows (plan 6.9): the dashboard
// metric and export endpoints. Needs the global DuckDbModule and ArchiveModule.

import { Module } from "@nestjs/common"
import { AnalyticsController } from "./analytics.controller"
import { AnalyticsRepository } from "./analytics.repository"
import { AnalyticsService } from "./analytics.service"

@Module({
	controllers: [AnalyticsController],
	providers: [AnalyticsRepository, AnalyticsService],
	exports: [AnalyticsService],
})
export class AnalyticsModule {}
