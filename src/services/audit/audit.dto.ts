// audit.dto.ts
// AuditEntry (dashboard shape) and the audit log query (plan 7.2: actor, action, target_type,
// target_id, network_id, from, to).

import { z } from "zod"
import { DateTime, UserRefSchema } from "@common/models/dash.models"
import { pageSchema, PageQuerySchema, zodDto } from "@common/response"

export const AuditEntrySchema = z
	.object({
		id: z.string(),
		at: DateTime,
		action: z.string(),
		severity: z.enum(["info", "warn", "critical"]),
		actor: UserRefSchema.nullable(),
		target_type: z.string().nullable(),
		target_id: z.string().nullable(),
		target_label: z.string().nullable(),
		network_id: z.number().int().nullable(),
		/** Only a salted hash of the IP is stored, so this stays null. */
		ip_prefix: z.string().nullable(),
		request_id: z.string().nullable(),
		before: z.record(z.string(), z.unknown()).nullable(),
		after: z.record(z.string(), z.unknown()).nullable(),
	})
	.meta({ id: "AuditEntry" })
export type AuditEntry = z.infer<typeof AuditEntrySchema>

export class AuditPageDto extends zodDto(pageSchema(AuditEntrySchema)) {}

const AuditFilters = {
	/** Actor public id. */
	actor: z.string().max(64).optional(),
	/** Exact action, or a prefix ending in `.*` (for example `roles.*`). */
	action: z.string().max(64).optional(),
	target_type: z.string().max(32).optional(),
	/** Users are addressed by public id. */
	target_id: z.string().max(64).optional(),
	from: z.iso.datetime().optional(),
	to: z.iso.datetime().optional(),
}

export class AuditQueryDto extends zodDto(
	PageQuerySchema.extend({
		...AuditFilters,
		network_id: z.coerce.number().int().optional(),
	}),
) {}

export class NetworkAuditQueryDto extends zodDto(PageQuerySchema.extend(AuditFilters)) {}

export class ActivityQueryDto extends zodDto(PageQuerySchema) {}
