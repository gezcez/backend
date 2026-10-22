// tracker-admin.controller.ts
// Dashboard tracker endpoints (plan 7.2): binding status and token health, poll log, stats and
// control actions (pause, resume, poll now, clear fallback, refresh token) answered by the
// tracker itself. Control actions are audited.

import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	ParseIntPipe,
	Post,
	Query,
	Req,
} from "@nestjs/common"
import { ApiTags } from "@nestjs/swagger"
import type { Request } from "express"
import { GezcezError } from "@common/errors"
import { ApiEnvelope, UseAuthorization } from "@common/middlewares"
import { decodeCursor, pageFrom } from "@common/utils"
import { AuditService } from "@services/audit/audit.service"
import { NetworksService } from "@services/networks/networks.service"
import { LiveFeedBus } from "./live-feed.bus"
import { TrackerHostService } from "./tracker-host.service"
import { TrackerRepository } from "./tracker.repository"
import {
	BindingStatsDto,
	ControlResultDto,
	isoOf,
	PollPageDto,
	PollsQueryDto,
	statusView,
	TrackerControlDto,
	TrackerOverviewDto,
} from "./tracker.dto"
import type { BindingStatus } from "./tracker.types"

const STATS_WINDOW_H = 24
const OK_OUTCOMES = new Set(["ok", "empty", "duplicate_header"])

@ApiTags("dash: tracker")
@Controller("dash/networks/:networkId")
export class TrackerAdminController {
	constructor(
		private readonly host: TrackerHostService,
		private readonly repository: TrackerRepository,
		private readonly bus: LiveFeedBus,
		private readonly networks: NetworksService,
		private readonly audit: AuditService,
	) {}

	private bindingOf(req: Request, bindingId: number) {
		const binding = this.networks.binding(bindingId)
		if (binding.network_id !== req.networkId)
			throw new GezcezError("NOT_FOUND", "Binding not found")
		return binding
	}

	private statusOf(bindingId: number): BindingStatus {
		return (
			this.host.status(bindingId) ?? {
				binding_id: bindingId,
				state: "unknown",
				message: this.host.isRunning() ? null : "The tracker is not running",
				last_feed_ts: this.bus.lastFeedTs(bindingId),
				last_poll_at: null,
				last_outcome: null,
				consecutive_failures: 0,
				next_poll_at: null,
				interval_s: null,
				url_variant: null,
				live_vehicles: this.bus.count(bindingId),
				subscribers: 0,
				credentials: null,
			}
		)
	}

	@Get("tracker")
	@UseAuthorization({
		permission: "tracker.read",
		scope: "network",
		description: "Tracker state per binding, with token health",
	})
	@ApiEnvelope(TrackerOverviewDto)
	overview(@Req() req: Request) {
		return {
			runner: this.host.runner,
			running: this.host.isRunning(),
			bindings: this.networks
				.bindings(req.networkId!)
				.map((b) => statusView(this.statusOf(b.id))),
		}
	}

	@Get("bindings/:bindingId/polls")
	@UseAuthorization({ permission: "tracker.read", scope: "network", description: "Poll log" })
	@ApiEnvelope(PollPageDto)
	polls(
		@Req() req: Request,
		@Param("bindingId", ParseIntPipe) bindingId: number,
		@Query() query: PollsQueryDto,
	) {
		this.bindingOf(req, bindingId)
		const filters = { b: bindingId }
		const offset = decodeCursor(query.cursor, filters)
		const rows = this.repository.polls(bindingId, query.limit + 1, offset)
		return pageFrom(
			rows.map((p) => ({
				id: p.id,
				binding_id: p.binding_id,
				started_at: isoOf(p.started_at)!,
				duration_ms: p.duration_ms,
				url_variant: p.url_variant,
				http_status: p.http_status,
				outcome: p.outcome,
				feed_at: isoOf(p.feed_ts),
				entities: p.entities,
				accepted: p.accepted,
				inserted: p.inserted,
				dropped: (p.dropped as Record<string, number> | null) ?? null,
				error: p.error,
			})),
			offset,
			query.limit,
			filters,
			null,
		)
	}

	@Get("bindings/:bindingId/stats")
	@UseAuthorization({
		permission: "tracker.read",
		scope: "network",
		description: "Poll outcomes over 24 h, hot rows, open runs",
	})
	@ApiEnvelope(BindingStatsDto)
	stats(@Req() req: Request, @Param("bindingId", ParseIntPipe) bindingId: number) {
		this.bindingOf(req, bindingId)
		const since = Math.floor(Date.now() / 1000) - STATS_WINDOW_H * 3600
		const outcomes = this.repository.pollOutcomes(bindingId, since)
		const polls = Object.fromEntries(outcomes.map((o) => [o.outcome, o.n]))
		const attempted = outcomes
			.filter((o) => !o.outcome.startsWith("skipped"))
			.reduce((sum, o) => sum + o.n, 0)
		const okCount = outcomes
			.filter((o) => OK_OUTCOMES.has(o.outcome))
			.reduce((sum, o) => sum + o.n, 0)
		return {
			binding_id: bindingId,
			window_hours: STATS_WINDOW_H,
			polls,
			success_rate: attempted ? Math.round((okCount / attempted) * 1000) / 1000 : null,
			positions_hot: this.repository.positionCount(bindingId),
			open_runs: this.repository.openRuns(bindingId).length,
			live_vehicles: this.bus.count(bindingId),
		}
	}

	@Post("bindings/:bindingId/control")
	@HttpCode(200)
	@UseAuthorization({
		permission: "tracker.control",
		scope: "network",
		description: "Pause, resume, poll now, clear the fallback URL or refresh the token",
	})
	@ApiEnvelope(ControlResultDto)
	async control(
		@Req() req: Request,
		@Param("bindingId", ParseIntPipe) bindingId: number,
		@Body() body: TrackerControlDto,
	) {
		this.bindingOf(req, bindingId)
		const result = await this.host.control({ type: body.action, binding_id: bindingId })
		this.audit.record("tracker.control", {
			req,
			target: { type: "binding", id: String(bindingId) },
			networkId: req.networkId,
			data: { action: body.action, reason: body.reason ?? null, ok: result.ok },
		})
		const status = result.status ?? this.host.status(bindingId) ?? null
		return {
			ok: result.ok,
			error: result.ok ? null : (result.error ?? "failed"),
			status: status ? statusView(status) : null,
		}
	}
}
