// cities.controller.ts
// GET /v1/cities, /v1/cities/:slug/manifest, /v1/networks/:networkId and /v1/providers.

import { Controller, Get, Header, Param, Res } from "@nestjs/common"
import { ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { ApiEnvelope, Public } from "@common/middlewares"
import { CityDto, CityManifestDto, NetworkManifestDto, ProviderPublicDto } from "./cities.dto"
import { CitiesService } from "./cities.service"

/** Sets a strong ETag; Express answers 304 itself when If-None-Match matches (req.fresh). */
function withEtag<T>(res: Response, body: T): T {
	res.setHeader("ETag", CitiesService.etag(body))
	return body
}

@ApiTags("transit")
@Public()
@Controller()
export class CitiesController {
	constructor(private readonly cities: CitiesService) {}

	@Get("cities")
	@Header("Cache-Control", "public, max-age=300")
	@ApiEnvelope([CityDto], { description: "Public cities with centre, bbox and networks" })
	list() {
		return this.cities.listCities()
	}

	@Get("cities/:slug/manifest")
	@Header("Cache-Control", "public, max-age=300")
	@ApiEnvelope(CityManifestDto, { description: "City manifest; honours If-None-Match" })
	manifest(@Param("slug") slug: string, @Res({ passthrough: true }) res: Response) {
		return withEtag(res, this.cities.manifest(slug))
	}

	@Get("networks/:networkId")
	@Header("Cache-Control", "public, max-age=300")
	@ApiEnvelope(NetworkManifestDto, { description: "One network's slice of the city manifest" })
	network(@Param("networkId") networkId: string, @Res({ passthrough: true }) res: Response) {
		return withEtag(res, this.cities.network(networkId))
	}

	@Get("providers")
	@Header("Cache-Control", "public, max-age=3600")
	@ApiEnvelope([ProviderPublicDto], { description: "Providers and what data they collect" })
	providers() {
		return this.cities.providers()
	}
}
