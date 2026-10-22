// flags.dto.ts

import { z } from "zod"
import { DateTime, UserRefSchema } from "@common/models/dash.models"
import { zodDto } from "@common/response"
import { FLAG_DEFINITIONS } from "./flag-definitions"

const FlagBase = z.object({
	key: z.string(),
	description: z.string(),
	/** Changing it needs step-up. */
	critical: z.boolean(),
	/** JSON value; its shape depends on the flag. */
	value: z.unknown(),
	default: z.unknown(),
	is_default: z.boolean(),
	updated_at: DateTime.nullable(),
	updated_by: UserRefSchema.nullable(),
})
export const FlagSchema = FlagBase.meta({ id: "Flag" })
export type Flag = z.infer<typeof FlagSchema>

export class FlagListDto extends zodDto(z.array(FlagSchema)) {}
export class FlagDto extends zodDto(FlagBase) {}

const FlagDetailBase = FlagBase.extend({
	history: z.array(
		z.object({
			at: DateTime,
			by: UserRefSchema.nullable(),
			before: z.unknown(),
			after: z.unknown(),
		}),
	),
})
export type FlagDetail = z.infer<typeof FlagDetailBase>
export class FlagDetailDto extends zodDto(FlagDetailBase) {}

export class FlagUpdateDto extends zodDto(
	z.object({
		/** New value, validated against the flag's schema. */
		value: z.unknown().optional(),
		/** Back to the code default. */
		reset: z.boolean().optional(),
	}),
) {}

const SettingsBase = z.object({
	signup: FLAG_DEFINITIONS["settings.signup"].schema,
	maintenance: FLAG_DEFINITIONS["settings.maintenance"].schema,
})
export type Settings = z.infer<typeof SettingsBase>
export class SettingsDto extends zodDto(SettingsBase) {}

const SettingsPatchBase = SettingsBase.partial().strict()
export type SettingsPatch = z.infer<typeof SettingsPatchBase>
export class SettingsPatchDto extends zodDto(SettingsPatchBase) {}

export class SystemNoticeDto extends zodDto(
	z.object({
		/** Maintenance banner for the web apps, or null. */
		maintenance: z.object({ message: z.object({ tr: z.string(), en: z.string() }) }).nullable(),
		signup_open: z.boolean(),
	}),
) {}
