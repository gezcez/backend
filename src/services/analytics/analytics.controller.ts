// analytics.controller.ts
// Dashboard analytics (plan 6.9 and 7.2): every metric as columnar JSON over a window of up to
// 90 local days with route, direction, day type and hour filters, and CSV or Parquet exports
// streamed from DuckDB COPY. Network scoped: analytics.read and analytics.export.

import { Controller, Get, Param, Query, Req, Res, StreamableFile } from "@nestjs/common"
import { ApiParam, ApiProduces, ApiResponse, ApiTags } from "@nestjs/swagger"
import type { Request, Response } from "express"
import fs from "node:fs"
import { GezcezError } from "@common/errors"
import { ApiEnvelope, RawResponse, UseAuthorization } from "@common/middlewares"
import { NetworksService } from "@services/networks/networks.service"
import {
	ANALYTICS_MAX_DAYS,
	AnalyticsExportQueryDto,
	AnalyticsQueryDto,
	MetricCatalogDto,
	MetricResultDto,
} from "./analytics.dto"
import { METRIC_KEYS, METRICS } from "./analytics.queries"
import { AnalyticsService, type MetricScope } from "./analytics.service"
import { DuckDBService } from "./duckdb.service"

const CLOSED_CACHE = "private, max-age=86400"
const RECENT_CACHE = "private, max-age=60"

const metricParam = ApiParam({ name: "metric", enum: METRIC_KEYS })

@ApiTags("dash: analytics")
@Controller("dash/networks/:networkId/analytics")
export class AnalyticsController {
	constructor(
		private readonly analytics: AnalyticsService,
		private readonly networks: NetworksService,
		private readonly duckdb: DuckDBService,
	) {}

	private scope(req: Request, bindingId?: number): MetricScope {
		const network = this.networks.network(String(req.networkId), false)
		const timezone = this.networks.cityById(network.city_id)?.timezone ?? "Europe/Istanbul"
		const bindings = this.networks.bindings(network.id).map((b) => b.id)
		if (bindingId !== undefined && !bindings.includes(bindingId))
			throw new GezcezError("NOT_FOUND", "Binding not found")
		return { bindingIds: bindingId === undefined ? bindings : [bindingId], timezone }
	}

	@Get()
	@UseAuthorization({
		permission: "analytics.read",
		scope: "network",
		description: "Analytics metric catalogue and archive range",
	})
	@ApiEnvelope(MetricCatalogDto)
	catalog(@Req() req: Request) {
		const scope = this.scope(req)
		return {
			metrics: METRIC_KEYS.map((key) => ({
				key,
				description: METRICS[key].description,
				datasets: METRICS[key].views,
			})),
			max_days: ANALYTICS_MAX_DAYS,
			h3: this.duckdb.h3Mode,
			archive: this.analytics.archiveRange(scope.bindingIds),
		}
	}

	@Get(":metric")
	@metricParam
	@UseAuthorization({
		permission: "analytics.read",
		scope: "network",
		description: "One analytics metric as columnar JSON",
	})
	@ApiEnvelope(MetricResultDto)
	async metric(
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response,
		@Param("metric") metric: string,
		@Query() query: AnalyticsQueryDto,
	) {
		const scope = this.scope(req, query.binding_id)
		const result = await this.analytics.run(metric, query, scope)
		res.setHeader(
			"Cache-Control",
			this.analytics.isClosed(metric, query, scope) ? CLOSED_CACHE : RECENT_CACHE,
		)
		return result
	}

	@Get(":metric/export")
	@metricParam
	@RawResponse()
	@UseAuthorization({
		permission: "analytics.export",
		scope: "network",
		description: "One analytics metric as a CSV or Parquet file",
	})
	@ApiProduces("text/csv", "application/vnd.apache.parquet")
	@ApiResponse({ status: 200, description: "The metric's rows as a file" })
	async export(
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response,
		@Param("metric") metric: string,
		@Query() query: AnalyticsExportQueryDto,
	): Promise<StreamableFile> {
		const scope = this.scope(req, query.binding_id)
		const { file, filename, closed } = await this.analytics.export(
			metric,
			query,
			scope,
			query.format,
		)
		const stream = fs.createReadStream(file)
		const cleanup = () => fs.rm(file, { force: true }, () => {})
		stream.on("close", cleanup)
		stream.on("error", cleanup)
		res.setHeader("Cache-Control", closed ? CLOSED_CACHE : "private, no-cache")
		return new StreamableFile(stream, {
			type:
				query.format === "csv"
					? "text/csv; charset=utf-8"
					: "application/vnd.apache.parquet",
			disposition: `attachment; filename="${filename}"`,
			length: fs.statSync(file).size,
		})
	}
}
