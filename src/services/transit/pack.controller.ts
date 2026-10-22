// pack.controller.ts
// GET /v1/networks/:networkId/pack (plan 6.5, P4): the offline bundle, served pre-serialised and
// pre-gzipped with a strong ETag; If-None-Match answers 304. Cached at Cloudflare for a day.

import { Controller, Get, Param, Req, Res } from "@nestjs/common"
import { ApiHeader, ApiTags } from "@nestjs/swagger"
import type { Request, Response } from "express"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"
import { ApiEnvelope, Public } from "@common/middlewares"
import { ModeSchema } from "@common/models/transit.models"
import { PackService } from "./pack.service"

const PackSchema = z.object({
	network: z.string().describe("Network slug"),
	network_id: z.number().int(),
	pack_version: z.string().describe("Same value as the manifest's pack_version"),
	built_at: z.string(),
	stops: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			code: z.string().nullable(),
			lat: z.number(),
			lon: z.number(),
			modes: z.array(ModeSchema),
			route_ids: z.array(z.string()),
		}),
	),
	routes: z.array(
		z.object({
			id: z.string(),
			short_name: z.string(),
			long_name: z.string(),
			mode: ModeSchema,
			colour: z.string().nullable(),
			text_colour: z.string().nullable(),
			directions: z.array(
				z.object({
					direction: z.union([z.literal(0), z.literal(1)]),
					headsign: z.string(),
					stop_ids: z.array(z.string()).describe("Ordered stops of the main pattern"),
				}),
			),
		}),
	),
})
export class PackDto extends createZodDto(PackSchema) {}

function etagMatches(header: string | undefined, etag: string): boolean {
	if (!header) return false
	return header
		.split(",")
		.map((v) => v.trim().replace(/^W\//, ""))
		.some((v) => v === etag || v === "*")
}

@ApiTags("transit")
@Public()
@Controller()
export class PackController {
	constructor(private readonly packs: PackService) {}

	@Get("networks/:networkId/pack")
	@ApiHeader({ name: "If-None-Match", required: false })
	@ApiEnvelope(PackDto, {
		description:
			"Offline pack of a network; re-download when the manifest's pack_version changes. Strong ETag, 304 on If-None-Match, gzip when accepted.",
	})
	pack(@Param("networkId") networkId: string, @Req() req: Request, @Res() res: Response): void {
		const built = this.packs.pack(networkId)
		res.setHeader("ETag", built.etag)
		res.setHeader("Cache-Control", "public, max-age=86400")
		res.setHeader("Vary", "Accept-Encoding")
		if (etagMatches(req.headers["if-none-match"], built.etag)) {
			res.status(304).end()
			return
		}
		res.setHeader("Content-Type", "application/json; charset=utf-8")
		if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
			res.setHeader("Content-Encoding", "gzip")
			res.status(200).end(Buffer.from(built.gzip))
		} else {
			res.status(200).end(built.json)
		}
	}
}
