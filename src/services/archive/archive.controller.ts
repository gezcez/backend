// archive.controller.ts
// Dashboard archive endpoints (plan 7.2): GET /v1/dash/archive (manifest, export and upload
// status, schedules) and POST /v1/dash/archive/:bindingId/:date/export (re-run one day, audited).

import { Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req } from "@nestjs/common"
import { ApiTags } from "@nestjs/swagger"
import type { Request } from "express"
import { GezcezError } from "@common/errors"
import { ApiEnvelope, UseAuthorization } from "@common/middlewares"
import { AuditService } from "@services/audit/audit.service"
import { NetworksService } from "@services/networks/networks.service"
import { utcDate } from "./archive.datasets"
import { ArchiveQueryDto, ArchiveStatusDto, DayExportDto } from "./archive.dto"
import { ArchiveJobs } from "./archive.jobs"
import { ArchiveService } from "./archive.service"

const iso = (seconds: number | null | undefined) =>
	seconds === null || seconds === undefined ? null : new Date(seconds * 1000).toISOString()

@ApiTags("dash: archive")
@Controller("dash/archive")
export class ArchiveAdminController {
	constructor(
		private readonly archive: ArchiveService,
		private readonly jobs: ArchiveJobs,
		private readonly networks: NetworksService,
		private readonly audit: AuditService,
	) {}

	@Get()
	@UseAuthorization({
		permission: "archive.read",
		scope: "global",
		description: "Archive manifest, export and upload status",
	})
	@ApiEnvelope(ArchiveStatusDto)
	status(@Query() query: ArchiveQueryDto) {
		const run = this.archive.lastRun
		return {
			uploader: this.archive.uploader.kind,
			can_write: this.archive.canWrite,
			schedules: this.jobs
				.schedules()
				.map((s) => ({ key: s.key, next_run_at: iso(s.next_run_at) })),
			last_run: run
				? {
						started_at: iso(run.started_at)!,
						finished_at: iso(run.finished_at)!,
						days: run.days,
						failures: run.failures,
						uploads_retried: run.uploads_retried,
						pruned: run.pruned,
					}
				: null,
			entries: this.archive
				.manifest({
					bindingId: query.binding_id,
					from: query.from,
					to: query.to,
					limit: query.limit,
				})
				.map((m) => ({
					binding_id: m.binding_id,
					date: m.date,
					dataset: m.dataset,
					rows: m.rows,
					bytes: m.bytes,
					sha256: m.sha256,
					path: m.path,
					exported_at: iso(m.exported_at)!,
					verified_at: iso(m.verified_at),
					uploaded_at: iso(m.uploaded_at),
					state: m.uploaded_at ? "uploaded" : m.verified_at ? "verified" : "failed",
				})),
		}
	}

	@Post(":bindingId/:date/export")
	@HttpCode(200)
	@UseAuthorization({
		permission: "archive.write",
		scope: "global",
		description: "Re-run the Parquet export of one binding and UTC date",
	})
	@ApiEnvelope(DayExportDto)
	async export(
		@Req() req: Request,
		@Param("bindingId", ParseIntPipe) bindingId: number,
		@Param("date") date: string,
	) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))
			throw new GezcezError("VALIDATION_FAILED", "date must be YYYY-MM-DD", {
				fields: { date: "YYYY-MM-DD" },
			})
		if (date >= utcDate(Math.floor(Date.now() / 1000)))
			throw new GezcezError("VALIDATION_FAILED", "Only complete UTC days can be exported", {
				fields: { date: "must be before today (UTC)" },
			})
		const binding = this.networks.binding(bindingId)
		const result = await this.archive.exportDay(bindingId, date)
		this.audit.record("archive.export", {
			req,
			target: { type: "binding", id: String(bindingId) },
			networkId: binding.network_id,
			data: {
				date,
				skipped: result.skipped,
				failed: result.datasets.filter((d) => d.error).map((d) => d.dataset),
			},
		})
		return result
	}
}
