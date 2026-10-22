// roles.dto.ts

import { createZodDto } from "nestjs-zod"
import { z } from "zod"
import { PERMISSION_KEYS, type PermissionKey } from "@common/permission-keys"

export const PermissionKeySchema = z
	.enum(PERMISSION_KEYS as [PermissionKey, ...PermissionKey[]])
	.meta({ id: "PermissionKey" })

export const RoleRefSchema = z.object({
	id: z.number().int(),
	key: z.string(),
	name: z.string(),
	level: z.number().int(),
})
export type RoleRef = z.infer<typeof RoleRefSchema>

export const PermissionListSchema = z.object({
	keys: z.array(
		z.object({
			key: z.string(),
			scope: z.enum(["global", "network"]),
			description: z.string(),
			sudo: z.boolean(),
			orphaned: z.boolean(),
		}),
	),
	routes: z.array(
		z.object({
			method: z.string(),
			path: z.string(),
			permission_key: z.string(),
			scope: z.enum(["global", "network"]),
			sudo: z.boolean(),
			description: z.string(),
		}),
	),
})
export class PermissionListDto extends createZodDto(PermissionListSchema) {}
