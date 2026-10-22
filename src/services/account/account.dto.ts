// account.dto.ts
// Shapes of oauth.md section 4 (bootstrap, sign-in and sign-up).

import { createZodDto } from "nestjs-zod"
import { z } from "zod"
import { namedZodDto } from "@common/response"

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
export class AccountSummaryDto extends createZodDto(AccountSummarySchema) {}

export const CsrfSchema = z.object({ token: z.string() })
export class CsrfDto extends createZodDto(CsrfSchema) {}

export const SessionInfoSchema = z.object({
	account: AccountSummarySchema,
	session: z.object({
		id: z.string(),
		auth_time: z.iso.datetime(),
		amr: Amr,
		expires_at: z.iso.datetime(),
	}),
})
export class SessionInfoDto extends createZodDto(SessionInfoSchema) {}

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
export class DeviceAccountsDto extends createZodDto(DeviceAccountsSchema) {}

export const SwitchSessionBody = z.object({ session_id: z.string().min(1).max(64) })
export class SwitchSessionDto extends createZodDto(SwitchSessionBody) {}

export const AccountResultSchema = z.object({ account: AccountSummarySchema })
export class AccountResultDto extends createZodDto(AccountResultSchema) {}

export const EmailIntent = z.enum(["signin", "signup", "reauth", "reset"])
export type EmailIntent = z.infer<typeof EmailIntent>

export const EmailStartBody = z.object({
	email: Email.optional(),
	intent: EmailIntent,
	request_id: z.string().max(64).optional(),
	turnstile_token: z.string().max(4096).optional(),
	locale: Locale.default("tr"),
})
export class EmailStartDto extends createZodDto(EmailStartBody) {}

export const EmailFlowSchema = z.object({
	flow_id: z.string(),
	expires_at: z.iso.datetime(),
	resend_available_at: z.iso.datetime(),
	code_length: z.literal(6),
})
export class EmailFlowDto extends createZodDto(EmailFlowSchema) {}

export const EmailResendBody = z.object({
	flow_id: z.string().min(1).max(64),
	turnstile_token: z.string().max(4096).optional(),
})
export class EmailResendDto extends createZodDto(EmailResendBody) {}

export const EmailResendResultSchema = z.object({
	resend_available_at: z.iso.datetime(),
	expires_at: z.iso.datetime(),
})
export class EmailResendResultDto extends createZodDto(EmailResendResultSchema) {}

export const EmailVerifyBody = z.object({
	flow_id: z.string().min(1).max(64),
	code: z.string().regex(/^\d{6}$/, "must be 6 digits"),
})
export class EmailVerifyDto extends createZodDto(EmailVerifyBody) {}

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
export class SignupCompleteDto extends createZodDto(SignupCompleteBody) {}
