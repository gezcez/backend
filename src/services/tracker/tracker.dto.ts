// tracker.dto.ts
// Dashboard tracker DTOs (plan 7.2). Times are ISO strings like the rest of /v1/dash.

import { createZodDto } from "nestjs-zod"
import { z } from "zod"
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, pageSchema } from "@common/response"
import type { BindingStatus } from "./tracker.types"

const iso = z.string().nullable()

export const CredentialStatusSchema = z.object({
	realm: z.string(),
	state: z.enum(["ok", "missing", "refreshing", "auth_failed", "unknown"]),
	expires_at: iso,
	refreshed_at: iso,
	failures: z.number().int(),
	secrets_set: z.record(z.string(), z.boolean()),
})

export const BindingStatusSchema = z.object({
	binding_id: z.number().int(),
	state: z.enum(["ok", "degraded", "down", "paused", "killed", "unknown"]),
	message: z.string().nullable(),
	last_feed_at: iso,
	last_poll_at: iso,
	last_outcome: z.string().nullable(),
	consecutive_failures: z.number().int(),
	next_poll_at: iso,
	interval_s: z.number().nullable(),
	url_variant: z.enum(["primary", "fallback"]).nullable(),
	live_vehicles: z.number().int(),
	subscribers: z.number().int(),
	credentials: CredentialStatusSchema.nullable(),
})
export class BindingStatusDto extends createZodDto(BindingStatusSchema) {}

export const TrackerOverviewSchema = z.object({
	runner: z.enum(["worker", "inline", "manual", "external", "off"]),
	running: z.boolean(),
	bindings: z.array(BindingStatusSchema),
})
export class TrackerOverviewDto extends createZodDto(TrackerOverviewSchema) {}

export const PollSchema = z.object({
	id: z.number().int(),
	binding_id: z.number().int(),
	started_at: z.string(),
	duration_ms: z.number().int(),
	url_variant: z.enum(["primary", "fallback"]).nullable(),
	http_status: z.number().int().nullable(),
	outcome: z.string(),
	feed_at: iso,
	entities: z.number().int(),
	accepted: z.number().int(),
	inserted: z.number().int(),
	dropped: z.record(z.string(), z.number()).nullable(),
	error: z.string().nullable(),
})
export class PollPageDto extends createZodDto(pageSchema(PollSchema)) {}

export class PollsQueryDto extends createZodDto(
	z.object({
		limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
		cursor: z.string().max(512).optional(),
	}),
) {}

export const BindingStatsSchema = z.object({
	binding_id: z.number().int(),
	window_hours: z.number().int(),
	polls: z.record(z.string(), z.number().int()),
	success_rate: z.number().nullable(),
	positions_hot: z.number().int(),
	open_runs: z.number().int(),
	live_vehicles: z.number().int(),
})
export class BindingStatsDto extends createZodDto(BindingStatsSchema) {}

export class TrackerControlDto extends createZodDto(
	z.object({
		action: z.enum(["pause", "resume", "poll-now", "reset-url", "refresh-token"]),
		reason: z.string().trim().max(500).optional(),
	}),
) {}

export const ControlResultSchema = z.object({
	ok: z.boolean(),
	error: z.string().nullable(),
	status: BindingStatusSchema.nullable(),
})
export class ControlResultDto extends createZodDto(ControlResultSchema) {}

export function isoOf(ts: number | null | undefined): string | null {
	return ts === null || ts === undefined ? null : new Date(ts * 1000).toISOString()
}

export function statusView(status: BindingStatus): z.infer<typeof BindingStatusSchema> {
	const c = status.credentials
	return {
		binding_id: status.binding_id,
		state: status.state,
		message: status.message,
		last_feed_at: isoOf(status.last_feed_ts),
		last_poll_at: isoOf(status.last_poll_at),
		last_outcome: status.last_outcome,
		consecutive_failures: status.consecutive_failures,
		next_poll_at: isoOf(status.next_poll_at),
		interval_s: status.interval_s,
		url_variant: status.url_variant,
		live_vehicles: status.live_vehicles,
		subscribers: status.subscribers,
		credentials: c
			? {
					realm: c.realm,
					state: c.state,
					expires_at: isoOf(c.expiresAt),
					refreshed_at: isoOf(c.refreshedAt),
					failures: c.failures,
					secrets_set: c.secretsSet,
				}
			: null,
	}
}
