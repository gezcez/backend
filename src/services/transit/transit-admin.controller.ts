// transit-admin.controller.ts
// Dashboard: static sync history and the manual sync trigger (plan 7.2).

import { Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req } from "@nestjs/common"
import { ApiTags } from "@nestjs/swagger"
import type { Request } from "express"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"
import { GezcezError } from "@common/errors"
import { ApiEnvelope, UseAuthorization } from "@common/middlewares"
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from "@common/response"
import { decodeCursor, pageFrom } from "@common/utils"
import { AuditService } from "@services/audit/audit.service"
import { NetworksService } from "@services/networks/networks.service"
import { SyncRunPageDto } from "./transit.dto"
import { TransitRepository } from "./transit.repository"
import { TransitSyncService } from "./transit-sync.service"

class SyncRunsQueryDto extends createZodDto(
	z.object({
		limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
		cursor: z.string().max(512).optional(),
	}),
) {}

const SyncResultSchema = z.object({
	binding_id: z.number().int(),
	run_id: z.number().int(),
	status: z.enum(["ok", "unchanged", "failed"]),
	version_id: z.number().int().nullable(),
	counts: z.record(z.string(), z.number()),
	warnings: z.array(z.string()),
	error: z.string().nullable(),
})
class SyncResultDto extends createZodDto(SyncResultSchema) {}

@ApiTags("dash: catalog")
@Controller("dash/networks/:networkId")
export class TransitAdminController {
	constructor(
		private readonly sync: TransitSyncService,
		private readonly networks: NetworksService,
		private readonly repository: TransitRepository,
		private readonly audit: AuditService,
	) {}

	@Get("sync-runs")
	@UseAuthorization({
		permission: "catalog.read",
		scope: "network",
		description: "Static sync history and warnings",
	})
	@ApiEnvelope(SyncRunPageDto)
	runs(@Req() req: Request, @Query() query: SyncRunsQueryDto) {
		const bindingIds = this.networks.bindings(req.networkId!).map((b) => b.id)
		const filters = { n: req.networkId }
		const offset = decodeCursor(query.cursor, filters)
		const rows = this.repository.listRuns(bindingIds, query.limit + 1, offset)
		return pageFrom(
			rows.map((r) => ({
				id: r.id,
				binding_id: r.binding_id,
				version_id: r.version_id,
				trigger: r.trigger,
				status: r.status,
				started_at: r.started_at.toISOString(),
				finished_at: r.finished_at?.toISOString() ?? null,
				counts: r.counts,
				warnings: r.warnings,
				error: r.error,
			})),
			offset,
			query.limit,
			filters,
			null,
		)
	}

	@Post("bindings/:bindingId/sync")
	@HttpCode(200)
	@UseAuthorization({
		permission: "catalog.sync",
		scope: "network",
		description: "Run the static sync of a binding now",
	})
	@ApiEnvelope(SyncResultDto)
	async run(@Req() req: Request, @Param("bindingId", ParseIntPipe) bindingId: number) {
		const binding = this.networks.binding(bindingId)
		if (binding.network_id !== req.networkId)
			throw new GezcezError("NOT_FOUND", "Binding not found")
		this.audit.record("catalog.sync", {
			req,
			target: { type: "binding", id: bindingId },
			networkId: req.networkId,
		})
		return this.sync.sync(bindingId, "manual")
	}
}
