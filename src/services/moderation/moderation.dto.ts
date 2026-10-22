// moderation.dto.ts

import { z } from "zod"
import { DateTime, UserRefSchema } from "@common/models/dash.models"
import { pageSchema, PageQuerySchema, zodDto } from "@common/response"

export const BAN_DURATIONS = { "1d": 1, "7d": 7, "30d": 30, permanent: null } as const

export class BanRequestDto extends zodDto(
	z.object({
		/** Shown to the user when they try to sign in. */
		public_reason: z.string().trim().min(3).max(500),
		/** Moderators only. */
		private_reason: z.string().trim().max(2000).optional(),
		duration: z.enum(["1d", "7d", "30d", "permanent"]),
	}),
) {}

export class UnbanRequestDto extends zodDto(
	z.object({ reason: z.string().trim().min(3).max(500) }),
) {}

export class UnbanResultDto extends zodDto(z.object({ unbanned: z.boolean() })) {}

export const ModerationActionSchema = z
	.object({
		id: z.string(),
		action: z.enum(["ban", "unban", "warn", "note"]),
		user: UserRefSchema,
		by: UserRefSchema.nullable(),
		public_reason: z.string().nullable(),
		private_reason: z.string().nullable(),
		until: DateTime.nullable(),
		/** A ban that is in force now. */
		active: z.boolean(),
		at: DateTime,
	})
	.meta({ id: "ModerationAction" })
export type ModerationAction = z.infer<typeof ModerationActionSchema>

export class ModerationPageDto extends zodDto(pageSchema(ModerationActionSchema)) {}

export class ModerationQueryDto extends zodDto(
	PageQuerySchema.extend({
		action: z.enum(["ban", "unban", "warn", "note"]).optional(),
		active: z
			.enum(["true", "false"])
			.transform((value) => value === "true")
			.optional(),
		/** Public id of the moderated user. */
		user_id: z.string().max(64).optional(),
	}),
) {}
