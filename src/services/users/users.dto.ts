// users.dto.ts
// GET /v1/me (the dashboard plan's section 4.2 contract) and PATCH /v1/me.

import { zodDto } from "@common/response"
import { z } from "zod"
import { PermissionKeySchema, RoleRefSchema } from "@services/roles/roles.dto"

const Locale = z.enum(["tr", "en"])

export const MeSchema = z.object({
	user: z.object({
		id: z.string(),
		display_name: z.string(),
		username: z.string().nullable(),
		email_masked: z.string(),
		locale: Locale,
		avatar_initials: z.string(),
	}),
	/** Unix seconds of the session's last real authentication (step-up UX). */
	auth_time: z.number().int(),
	amr: z.array(z.enum(["otp", "pwd", "webauthn"])),
	global: z.object({
		roles: z.array(RoleRefSchema),
		permissions: z.array(PermissionKeySchema),
	}),
	/** Only networks where the user holds a role; a global grant adds no entries. */
	networks: z.array(
		z.object({
			id: z.number().int(),
			slug: z.string(),
			name: z.string(),
			city: z.object({ id: z.number().int(), slug: z.string(), name: z.string() }),
			roles: z.array(RoleRefSchema),
			permissions: z.array(PermissionKeySchema),
		}),
	),
})
export class MeDto extends zodDto(MeSchema) {}

export const PatchMeBody = z
	.object({
		display_name: z.string().trim().min(1).max(64).optional(),
		locale: Locale.optional(),
	})
	.refine((body) => body.display_name !== undefined || body.locale !== undefined, {
		message: "Nothing to update",
	})
export class PatchMeDto extends zodDto(PatchMeBody) {}
