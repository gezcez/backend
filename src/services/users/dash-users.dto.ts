// dash-users.dto.ts
// Dashboard user search, detail, admin sessions and global role assignment (plan 6.3, 7.2).

import { createZodDto } from "nestjs-zod"
import { z } from "zod"
import {
	DateTime,
	ErrorCodeRef,
	NetworkRefSchema,
	ReasonSchema,
	RoleOperationsSchema,
	UserRefSchema,
} from "@common/models/dash.models"
import { pageSchema, PageQuerySchema } from "@common/response"
import { RoleRefSchema } from "@services/roles/roles.dto"

export const UserStatusSchema = z
	.enum(["active", "unverified", "banned", "pending_deletion"])
	.meta({ id: "UserStatus" })
export type DashUserStatus = z.infer<typeof UserStatusSchema>

export const DashUserListItemSchema = z
	.object({
		id: z.string(),
		display_name: z.string(),
		username: z.string().nullable(),
		email_masked: z.string(),
		status: UserStatusSchema,
		created_at: DateTime,
		last_active_at: DateTime.nullable(),
		role_count: z.number().int(),
	})
	.meta({ id: "DashUserListItem" })

export class DashUserPageDto extends createZodDto(pageSchema(DashUserListItemSchema)) {}

export class DashUserQueryDto extends createZodDto(
	PageQuerySchema.extend({
		status: UserStatusSchema.optional(),
		/** Role key, held anywhere (or in `network_id` when both are given). */
		role: z.string().max(32).optional(),
		network_id: z.coerce.number().int().optional(),
		/** Created at or after. */
		from: z.iso.datetime().optional(),
		to: z.iso.datetime().optional(),
	}),
) {}

const BanBase = z.object({
	public_reason: z.string(),
	private_reason: z.string().nullable(),
	until: DateTime.nullable(),
	created_at: DateTime,
	created_by: UserRefSchema.nullable(),
})
export const BanSchema = BanBase.meta({ id: "Ban" })
/** Named after the component (class names become schema names). */
export class Ban extends createZodDto(BanBase) {}

export const RoleAssignmentSchema = z
	.object({
		network: NetworkRefSchema.nullable(),
		role: RoleRefSchema,
		granted_at: DateTime,
		granted_by: UserRefSchema.nullable(),
	})
	.meta({ id: "RoleAssignment" })

export const DashUserSchema = z.object({
	id: z.string(),
	display_name: z.string(),
	username: z.string().nullable(),
	email_masked: z.string(),
	status: UserStatusSchema,
	locale: z.enum(["tr", "en"]),
	created_at: DateTime,
	last_active_at: DateTime.nullable(),
	email_verified: z.boolean(),
	methods: z.object({
		email_code: z.boolean(),
		password: z.boolean(),
		passkeys: z.number().int(),
	}),
	roles: z.array(RoleAssignmentSchema),
	ban: BanSchema.nullable(),
})
export class DashUser extends createZodDto(DashUserSchema) {}

export class RevealEmailDto extends createZodDto(z.object({ email: z.email() })) {}

export const UserSessionSchema = z.object({
	/** `sso_<session id>` or `rf_<refresh family id>`. */
	id: z.string(),
	kind: z.enum(["sso", "refresh"]),
	app: z.object({ client_id: z.string(), name: z.string() }).nullable(),
	device: z.string(),
	ip_prefix: z.string().nullable(),
	created_at: DateTime,
	last_used_at: DateTime.nullable(),
	expires_at: DateTime,
})
export class UserSession extends createZodDto(UserSessionSchema) {}

export class ReasonDto extends createZodDto(ReasonSchema) {}
export { RevokedCountDto } from "@services/account/account.dto"

export class RoleOperationsDto extends createZodDto(RoleOperationsSchema) {}
export class RoleOperationResultsDto extends createZodDto(
	z.object({
		results: z.array(
			z.object({
				role_id: z.number().int(),
				op: z.enum(["grant", "revoke"]),
				ok: z.boolean(),
				error_code: ErrorCodeRef.nullable(),
			}),
		),
	}),
) {}
