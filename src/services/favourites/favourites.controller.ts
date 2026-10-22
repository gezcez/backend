// favourites.controller.ts
// GET and PUT /v1/me/favourites (scope `transit`). The ETag is `"<version>"`; PUT needs If-Match.

import { Body, Controller, Get, Headers, Put, Res } from "@nestjs/common"
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import type { RequestAuth } from "@common/jwt.types"
import { ApiEnvelope, CurrentAuth, RequireScope } from "@common/middlewares"
import { FavouritesDocDto, PutFavouritesDto } from "./favourites.dto"
import { FavouritesService } from "./favourites.service"

@ApiTags("me")
@Controller("me/favourites")
export class FavouritesController {
	constructor(private readonly favourites: FavouritesService) {}

	@Get()
	@RequireScope("transit")
	@ApiOperation({ summary: 'The favourites document, with ETag "<version>"' })
	@ApiEnvelope(FavouritesDocDto)
	get(
		@CurrentAuth() auth: RequestAuth,
		@Res({ passthrough: true }) res: Response,
	): FavouritesDocDto {
		const doc = this.favourites.get(auth.userId)
		res.setHeader("ETag", `"${doc.version}"`)
		res.setHeader("Cache-Control", "private, no-store")
		return doc
	}

	@Put()
	@RequireScope("transit")
	@ApiHeader({ name: "If-Match", required: true, description: 'The version last read, e.g. "3"' })
	@ApiOperation({
		summary: "Replace the favourites document; 412 VERSION_CONFLICT when If-Match is stale",
	})
	@ApiEnvelope(FavouritesDocDto)
	put(
		@CurrentAuth() auth: RequestAuth,
		@Headers("if-match") ifMatch: string | undefined,
		@Body() body: PutFavouritesDto,
		@Res({ passthrough: true }) res: Response,
	): FavouritesDocDto {
		const doc = this.favourites.put(auth.userId, ifMatch, body)
		res.setHeader("ETag", `"${doc.version}"`)
		res.setHeader("Cache-Control", "private, no-store")
		return doc
	}
}
