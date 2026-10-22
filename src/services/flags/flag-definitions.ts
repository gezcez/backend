// flag-definitions.ts
// Every flag and setting lives here with its type, default and description; core.db only
// stores values that differ from the default (plan 6.16). `app.*` flags feed /v1/app/config;
// `settings.*` keys back the dashboard settings page. Critical flags need step-up to change.

import { z } from "zod"

const Version = z.string().regex(/^\d+\.\d+\.\d+$/)
const PlatformVersion = z.union([
	Version,
	z.object({ ios: Version.optional(), android: Version.optional() }).strict(),
])
const Localised = z.object({ tr: z.string().max(500), en: z.string().max(500) }).strict()

export interface FlagDefinition<T = unknown> {
	description: string
	schema: z.ZodType<T>
	default: T
	/** Changing it needs step-up (kill switches and similar). */
	critical: boolean
}

function define<T>(definition: FlagDefinition<T>): FlagDefinition<T> {
	return definition
}

export const FLAG_DEFINITIONS = {
	"app.min_supported_version": define({
		description: "Oldest app version allowed to run (one, or per platform)",
		schema: PlatformVersion,
		default: "0.0.0" as z.infer<typeof PlatformVersion>,
		critical: true,
	}),
	"app.soft_update_version": define({
		description: "Versions below this see an update prompt (null: none)",
		schema: PlatformVersion.nullable(),
		default: null as z.infer<typeof PlatformVersion> | null,
		critical: false,
	}),
	"app.features": define({
		description: "Feature flags sent to the app",
		schema: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), z.boolean()),
		default: {} as Record<string, boolean>,
		critical: false,
	}),
	"app.kill_switches": define({
		description: "App features to turn off (false turns a feature off)",
		schema: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), z.boolean()),
		default: {} as Record<string, boolean>,
		critical: true,
	}),
	"app.announcement": define({
		description: "Banner in the app (null: none)",
		schema: z
			.object({
				id: z.string().min(1).max(64),
				level: z.enum(["info", "warning"]),
				title: Localised,
				body: Localised,
				url: z.url().nullable(),
			})
			.strict()
			.nullable(),
		default: null as {
			id: string
			level: "info" | "warning"
			title: { tr: string; en: string }
			body: { tr: string; en: string }
			url: string | null
		} | null,
		critical: false,
	}),
	"settings.signup": define({
		description: "Whether new accounts can be created",
		schema: z.object({ open: z.boolean() }).strict(),
		default: { open: true },
		critical: true,
	}),
	"settings.maintenance": define({
		description: "Maintenance banner on the web apps",
		schema: z.object({ enabled: z.boolean(), message: Localised }).strict(),
		default: { enabled: false, message: { tr: "", en: "" } },
		critical: false,
	}),
} as const

export type FlagKey = keyof typeof FLAG_DEFINITIONS
export type FlagValue<K extends FlagKey> = (typeof FLAG_DEFINITIONS)[K]["default"]

export const FLAG_KEYS = Object.keys(FLAG_DEFINITIONS) as FlagKey[]

export function isFlagKey(value: string): value is FlagKey {
	return value in FLAG_DEFINITIONS
}

/** Settings groups: `settings.<group>`. */
export const SETTINGS_GROUPS = ["signup", "maintenance"] as const
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]
