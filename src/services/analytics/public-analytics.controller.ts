// public-analytics.controller.ts
// GET /v1/public/analytics/quality (cached 1 h) and /v1/public/analytics/fleet (10 min):
// aggregate-only, anonymous, rate limited (analytics-public) and cached at Cloudflare.

import { Controller, Get, Header, Query } from "@nestjs/common"
import { ApiTags } from "@nestjs/swagger"
import { ApiEnvelope, Public, RateLimit } from "@common/middlewares"
import {
	PublicFleetDto,
	PublicFleetQueryDto,
	PublicQualityDto,
	PublicQualityQueryDto,
} from "./public-analytics.dto"
import { PublicAnalyticsService } from "./public-analytics.service"

@ApiTags("public: analytics")
@Public()
@Controller("public/analytics")
export class PublicAnalyticsController {
	constructor(private readonly service: PublicAnalyticsService) {}

	@Get("quality")
	@RateLimit("analytics-public")
	@Header("Cache-Control", "public, max-age=3600")
	@ApiEnvelope(PublicQualityDto, { description: "Daily data reliability score per city" })
	quality(@Query() query: PublicQualityQueryDto) {
		return this.service.quality(query.city, query.days)
	}

	@Get("fleet")
	@RateLimit("analytics-public")
	@Header("Cache-Control", "public, max-age=600")
	@ApiEnvelope(PublicFleetDto, { description: "Fleet in service today and yesterday" })
	fleet(@Query() query: PublicFleetQueryDto) {
		return this.service.fleet(query.city)
	}
}
