// apps.dto.ts
// OAuth client administration (plan 6.2). Names follow the dashboard's components.

import { MAX_ACCESS_TTL_S } from "@common/constants"
import { z } from "zod"
import { DateTime, ReasonSchema } from "@common/models/dash.models"
import { pageSchema, PageQuerySchema, zodDto } from "@common/response"

export const AppTypeSchema = z.enum(["public", "confidential"]).meta({ id: "AppType" })
export const AppPlatformSchema = z.enum(["web", "native", "dev"]).meta({ id: "AppPlatform" })

export const AppListItemSchema = z
	.object({
		client_id: z.string(),
		name: z.string(),
		type: AppTypeSchema,
		platform: AppPlatformSchema,
		first_party: z.boolean(),
		system: z.boolean(),
		redirect_uri_count: z.number().int(),
		active_families: z.number().int(),
		tokens_24h: z.number().int(),
		created_at: DateTime,
	})
	.meta({ id: "AppListItem" })
export class AppPageDto extends zodDto(pageSchema(AppListItemSchema)) {}
export class AppQueryDto extends zodDto(PageQuerySchema) {}

export const AppSecretSchema = z
	.object({
		/** `current` or `previous`. */
		id: z.string(),
		/** First characters of the secret. */
		prefix: z.string(),
		state: z.enum(["current", "previous"]),
		created_at: DateTime,
		last_used_at: DateTime.nullable(),
		/** When a previous secret stops working (grace end). */
		expires_at: DateTime.nullable(),
	})
	.meta({ id: "AppSecret" })

const AppDetailBase = z.object({
	client_id: z.string(),
	name: z.string(),
	description: z.string(),
	logo_url: z.string().nullable(),
	homepage_url: z.string().nullable(),
	type: AppTypeSchema,
	platform: AppPlatformSchema,
	first_party: z.boolean(),
	system: z.boolean(),
	redirect_uris: z.array(z.string()),
	scopes: z.array(z.string()),
	access_ttl_s: z.number().int(),
	refresh_ttl_s: z.number().int(),
	refresh_max_s: z.number().int(),
	secrets: z.array(AppSecretSchema),
	active_families: z.number().int(),
	tokens_24h: z.number().int(),
	/** Tokens issued per UTC day, last 30 days, days with tokens only. */
	usage: z.array(z.object({ date: z.string(), tokens: z.number().int() })),
	created_at: DateTime,
	updated_at: DateTime,
})
export const AppDetailSchema = AppDetailBase.meta({ id: "AppDetail" })
export class AppDetail extends zodDto(AppDetailBase) {}
export type AppDetailData = z.infer<typeof AppDetailBase>

const Url = z.url({ protocol: /^https?$/ }).max(500)
const RedirectUris = z.array(z.string().trim().min(1).max(500)).max(20)

export class CreateAppDto extends zodDto(
	z.object({
		name: z.string().trim().min(2).max(64),
		description: z.string().trim().max(280).default(""),
		type: AppTypeSchema,
		platform: AppPlatformSchema,
		homepage_url: Url.nullable().default(null),
		redirect_uris: RedirectUris.min(1),
	}),
) {}

export class CreatedAppDto extends zodDto(
	z.object({
		app: AppDetailSchema,
		/** Shown once; null for public clients. */
		secret: z.string().nullable(),
	}),
) {}

export class UpdateAppDto extends zodDto(
	z
		.object({
			name: z.string().trim().min(2).max(64),
			description: z.string().trim().max(280),
			logo_url: Url.nullable(),
			homepage_url: Url.nullable(),
			redirect_uris: RedirectUris.min(1),
			scopes: z.array(z.string()).min(1).max(20),
			first_party: z.boolean(),
			access_ttl_s: z.number().int().min(300).max(MAX_ACCESS_TTL_S),
			refresh_ttl_s: z.number().int().min(3600).max(7_776_000),
			refresh_max_s: z.number().int().min(3600).max(31_536_000),
		})
		.partial()
		.refine((body) => Object.values(body).some((value) => value !== undefined), {
			message: "Nothing to update",
		}),
) {}

export class RotateSecretDto extends zodDto(z.object({ grace: z.enum(["none", "24h", "7d"]) })) {}
export class RotatedSecretDto extends zodDto(
	z.object({ secret: z.string(), meta: AppSecretSchema }),
) {}
export class SecretRevokedDto extends zodDto(z.object({ revoked: z.boolean() })) {}
export class AppReasonDto extends zodDto(ReasonSchema) {}
