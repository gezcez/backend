// roles.dto.ts

import { zodDto } from "@common/response"
import { z } from "zod"
import { DateTime, ErrorCodeRef, NetworkRefSchema } from "@common/models/dash.models"
import { PERMISSION_KEYS, type PermissionKey } from "@common/permission-keys"

export const PermissionKeySchema = z
	.enum(PERMISSION_KEYS as [PermissionKey, ...PermissionKey[]])
	.meta({ id: "PermissionKey" })

export const RoleRefBase = z.object({
	id: z.number().int(),
	key: z.string(),
	name: z.string(),
	level: z.number().int(),
})
export const RoleRefSchema = RoleRefBase.meta({ id: "RoleRef" })
export type RoleRef = z.infer<typeof RoleRefSchema>

// Dashboard: roles, matrix and registry

const RoleBase = z.object({
	id: z.number().int(),
	key: z.string(),
	name: z.string(),
	description: z.string(),
	level: z.number().int(),
	immutable: z.boolean(),
	permission_count: z.number().int(),
	member_count: z.number().int(),
})
export const RoleSchema = RoleBase.meta({ id: "Role" })
/** Named after the component. */
export class Role extends zodDto(RoleBase) {}

export class RoleDetail extends zodDto(
	RoleBase.extend({
		permissions: z.array(PermissionKeySchema),
		members_by_network: z.array(
			z.object({ network: NetworkRefSchema.nullable(), count: z.number().int() }),
		),
		created_at: DateTime,
		updated_at: DateTime,
	}),
) {}

/** Levels stay below root (1000), which only the seed assigns. */
const Level = z.number().int().min(1).max(999)

export class CreateRoleDto extends zodDto(
	z.object({
		key: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
		name: z.string().trim().min(2).max(48),
		description: z.string().trim().max(280).default(""),
		level: Level,
	}),
) {}

export class UpdateRoleDto extends zodDto(
	z
		.object({
			name: z.string().trim().min(2).max(48).optional(),
			description: z.string().trim().max(280).optional(),
			level: Level.optional(),
		})
		.refine((body) => Object.values(body).some((value) => value !== undefined), {
			message: "Nothing to update",
		}),
) {}

export class ReplacePermissionsDto extends zodDto(
	z.object({ permissions: z.array(PermissionKeySchema).max(200) }),
) {}

const PermissionInfoBase = z.object({
	key: PermissionKeySchema,
	scope: z.enum(["global", "network"]),
	sudo: z.boolean(),
	description: z.string(),
})
export const PermissionInfoSchema = PermissionInfoBase.meta({ id: "PermissionInfo" })
export class PermissionInfo extends zodDto(PermissionInfoBase) {}

export class PermissionMatrixDto extends zodDto(
	z.object({
		roles: z.array(RoleSchema),
		permissions: z.array(PermissionInfoSchema),
		grants: z.array(
			z.object({ role_id: z.number().int(), permissions: z.array(PermissionKeySchema) }),
		),
	}),
) {}

const PermissionOp = z.object({
	role_id: z.number().int(),
	permission_key: PermissionKeySchema,
	op: z.enum(["grant", "revoke"]),
})
export class PermissionBatchDto extends zodDto(
	z.object({ operations: z.array(PermissionOp).min(1).max(500) }),
) {}
export class PermissionBatchResultDto extends zodDto(
	z.object({
		results: z.array(
			PermissionOp.extend({ ok: z.boolean(), error_code: ErrorCodeRef.nullable() }),
		),
	}),
) {}

export class PermissionRegistryEntry extends zodDto(
	z.object({
		/** Orphaned keys are no longer in code, so this is any string. */
		key: z.string(),
		scope: z.enum(["global", "network"]),
		sudo: z.boolean(),
		description: z.string(),
		routes: z.array(z.object({ method: z.string(), path: z.string(), sudo: z.boolean() })),
		roles: z.array(RoleRefSchema),
		first_registered_at: DateTime,
		last_seen_at: DateTime,
		orphaned_at: DateTime.nullable(),
	}),
) {}

export class DeletedDto extends zodDto(z.object({ deleted: z.boolean() })) {}
