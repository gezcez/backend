// account.dto.ts
// Shapes of oauth.md section 4 (bootstrap, sign-in and sign-up).

import { z } from "zod"
import { namedZodDto, zodDto } from "@common/response"

const Locale = z.enum(["tr", "en"])
const Amr = z.array(z.enum(["otp", "pwd", "webauthn"]))
const Email = z.email().max(254)

export const AccountSummarySchema = z.object({
	id: z.string(),
	display_name: z.string(),
	email_masked: z.string(),
	email: z.string().optional(),
	avatar_initials: z.string(),
	locale: Locale,
})
export class AccountSummaryDto extends zodDto(AccountSummarySchema) {}

export const CsrfSchema = z.object({ token: z.string() })
export class CsrfDto extends zodDto(CsrfSchema) {}

export const SessionInfoSchema = z.object({
	account: AccountSummarySchema,
	session: z.object({
		id: z.string(),
		auth_time: z.iso.datetime(),
		amr: Amr,
		expires_at: z.iso.datetime(),
	}),
})
export class SessionInfoDto extends zodDto(SessionInfoSchema) {}

export const DeviceAccountsSchema = z.object({
	accounts: z.array(
		z.object({
			session_id: z.string(),
			account: AccountSummarySchema,
			active: z.boolean(),
			signed_out: z.boolean(),
		}),
	),
})
export class DeviceAccountsDto extends zodDto(DeviceAccountsSchema) {}

export const SwitchSessionBody = z.object({ session_id: z.string().min(1).max(64) })
export class SwitchSessionDto extends zodDto(SwitchSessionBody) {}

export const AccountResultSchema = z.object({ account: AccountSummarySchema })
export class AccountResultDto extends zodDto(AccountResultSchema) {}

export const EmailIntent = z.enum(["signin", "signup", "reauth", "reset"])
export type EmailIntent = z.infer<typeof EmailIntent>

export const EmailStartBody = z.object({
	email: Email.optional(),
	intent: EmailIntent,
	request_id: z.string().max(64).optional(),
	turnstile_token: z.string().max(4096).optional(),
	locale: Locale.default("tr"),
})
export class EmailStartDto extends zodDto(EmailStartBody) {}

export const EmailFlowSchema = z.object({
	flow_id: z.string(),
	expires_at: z.iso.datetime(),
	resend_available_at: z.iso.datetime(),
	code_length: z.literal(6),
})
export class EmailFlowDto extends zodDto(EmailFlowSchema) {}

export const EmailResendBody = z.object({
	flow_id: z.string().min(1).max(64),
	turnstile_token: z.string().max(4096).optional(),
})
export class EmailResendDto extends zodDto(EmailResendBody) {}

export const EmailResendResultSchema = z.object({
	resend_available_at: z.iso.datetime(),
	expires_at: z.iso.datetime(),
})
export class EmailResendResultDto extends zodDto(EmailResendResultSchema) {}

export const EmailVerifyBody = z.object({
	flow_id: z.string().min(1).max(64),
	code: z.string().regex(/^\d{6}$/, "must be 6 digits"),
})
export class EmailVerifyDto extends zodDto(EmailVerifyBody) {}

export const EmailVerifyResultSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("signed_in"),
		account: AccountSummarySchema,
		auth_time: z.iso.datetime(),
	}),
	z.object({ status: z.literal("needs_profile"), profile_token: z.string(), email: z.string() }),
	z.object({ status: z.literal("reset_ready"), reset_token: z.string() }),
])
export const EmailVerifyResultDto = namedZodDto("EmailVerifyResultDto", EmailVerifyResultSchema)
export type EmailVerifyResultDto = z.infer<typeof EmailVerifyResultSchema>

export const SignupCompleteBody = z.object({
	profile_token: z.string().min(1).max(2048),
	display_name: z.string().trim().min(1).max(40),
	tos_version: z.string().min(1).max(32),
	privacy_version: z.string().min(1).max(32),
	locale: Locale,
})
export class SignupCompleteDto extends zodDto(SignupCompleteBody) {}

// Passwords (optional method, plan section 6.1.1). Length rules are checked by the service so
// a too-short password is AUTH_PASSWORD_WEAK, not a validation error.
const Password = z.string().min(1).max(1024)

export const PasswordLoginBody = z.object({
	email: Email,
	password: Password,
	request_id: z.string().max(64).optional(),
	turnstile_token: z.string().max(4096).optional(),
})
export class PasswordLoginDto extends zodDto(PasswordLoginBody) {}

export const PasswordResetBody = z.object({
	reset_token: z.string().min(1).max(2048),
	new_password: Password,
})
export class PasswordResetDto extends zodDto(PasswordResetBody) {}

export const ReauthBody = z.object({ password: Password })
export class ReauthDto extends zodDto(ReauthBody) {}

export const PasswordSetBody = z.object({
	new_password: Password,
	/** Other sessions are signed out unless this is true. */
	keep_sessions: z.boolean().default(false),
})
export class PasswordSetDto extends zodDto(PasswordSetBody) {}

export const SignedInSchema = z.object({
	status: z.literal("signed_in"),
	account: AccountSummarySchema,
	auth_time: z.iso.datetime(),
})
export class SignedInDto extends zodDto(SignedInSchema) {}

// Account self-service (oauth.md section 4.4)

const ScopeInfo = z.object({ key: z.string(), i18n_key: z.string() })

export const ProfileSchema = z.object({
	id: z.string(),
	display_name: z.string(),
	email: z.string(),
	email_verified_at: z.iso.datetime().nullable(),
	locale: Locale,
	created_at: z.iso.datetime(),
	has_password: z.boolean(),
	passkey_count: z.number().int(),
	deletion: z.object({ delete_at: z.iso.datetime() }).optional(),
})
export class ProfileDto extends zodDto(ProfileSchema) {}

export const ProfilePatchBody = z
	.object({
		display_name: z.string().trim().min(1).max(40).optional(),
		locale: Locale.optional(),
	})
	.refine((body) => body.display_name !== undefined || body.locale !== undefined, {
		message: "Nothing to update",
	})
export class ProfilePatchDto extends zodDto(ProfilePatchBody) {}

export const EmailChangeBody = z.object({
	new_email: Email,
	turnstile_token: z.string().max(4096).optional(),
	locale: Locale.optional(),
})
export class EmailChangeDto extends zodDto(EmailChangeBody) {}

export const EmailChangeResultSchema = z.object({ email: z.string() })
export class EmailChangeResultDto extends zodDto(EmailChangeResultSchema) {}

export const SessionListSchema = z.object({
	sessions: z.array(
		z.object({
			id: z.string(),
			current: z.boolean(),
			device: z.object({
				label: z.string(),
				os: z.string(),
				browser: z.string(),
				kind: z.enum(["desktop", "mobile", "app"]),
			}),
			approx_location: z.string().optional(),
			created_at: z.iso.datetime(),
			last_seen_at: z.iso.datetime(),
			amr: Amr,
			apps: z.array(z.object({ client_id: z.string(), name: z.string() })),
		}),
	),
})
export class SessionListDto extends zodDto(SessionListSchema) {}

export const RevokedCountSchema = z.object({ revoked: z.number().int() })
export class RevokedCountDto extends zodDto(RevokedCountSchema) {}

export const AuthorizedAppsSchema = z.object({
	apps: z.array(
		z.object({
			client_id: z.string(),
			name: z.string(),
			logo_url: z.string().optional(),
			first_party: z.boolean(),
			scopes: z.array(ScopeInfo),
			granted_at: z.iso.datetime().nullable(),
			last_used_at: z.iso.datetime().nullable(),
			active_sessions: z.number().int(),
		}),
	),
})
export class AuthorizedAppsDto extends zodDto(AuthorizedAppsSchema) {}

export const SecuritySchema = z.object({
	has_password: z.boolean(),
	password_updated_at: z.iso.datetime().optional(),
	passkeys: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			created_at: z.iso.datetime(),
			last_used_at: z.iso.datetime().nullable(),
			device_hint: z.string().nullable(),
		}),
	),
	recent_events: z.array(
		z.object({
			type: z.string(),
			at: z.iso.datetime(),
			device_label: z.string().optional(),
			approx_location: z.string().optional(),
		}),
	),
})
export class SecurityDto extends zodDto(SecuritySchema) {}

export const PrivacySchema = z.object({
	location_history_opt_in: z.boolean(),
	product_emails: z.boolean(),
})
export class PrivacyDto extends zodDto(PrivacySchema) {}

export const PrivacyPatchBody = PrivacySchema.partial()
export class PrivacyPatchDto extends zodDto(PrivacyPatchBody) {}
