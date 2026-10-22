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

export class ForgetDeviceAccountResultDto extends zodDto(
	z.object({
		forgotten: z.boolean(),
		/** True when the forgotten account was the active one (the session cookie is cleared). */
		signed_out_current: z.boolean(),
	}),
) {}

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

// Passkeys (P5, oauth.md sections 4.3, 4.4 and 5.11). Credential and options bodies are the
// WebAuthn JSON shapes that @simplewebauthn/browser produces and consumes.

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]*$/, "must be base64url")
const Transport = z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"])
const CredentialDescriptor = z.object({
	id: z.string(),
	/** Always "public-key". */
	type: z.string(),
	transports: z.array(z.string()).optional(),
})
const ExtensionResults = z.record(z.string(), z.unknown())
const ExtensionInputs = z.object({
	appid: z.string().optional(),
	credProps: z.boolean().optional(),
	hmacCreateSecret: z.boolean().optional(),
	minPinLength: z.boolean().optional(),
})

export const RegistrationCredentialSchema = z.object({
	id: Base64Url.min(1).max(1024),
	rawId: Base64Url.min(1).max(1024),
	type: z.literal("public-key"),
	response: z.object({
		clientDataJSON: Base64Url.max(8192),
		attestationObject: Base64Url.max(65536),
		authenticatorData: Base64Url.max(65536).optional(),
		transports: z.array(Transport).max(8).optional(),
		publicKeyAlgorithm: z.number().int().optional(),
		publicKey: Base64Url.max(8192).optional(),
	}),
	authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
	clientExtensionResults: ExtensionResults.default({}),
})

export const AuthenticationCredentialSchema = z.object({
	id: Base64Url.min(1).max(1024),
	rawId: Base64Url.min(1).max(1024),
	type: z.literal("public-key"),
	response: z.object({
		clientDataJSON: Base64Url.max(8192),
		authenticatorData: Base64Url.max(65536),
		signature: Base64Url.max(8192),
		userHandle: Base64Url.max(1024).optional(),
	}),
	authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
	clientExtensionResults: ExtensionResults.default({}),
})

export const PasskeyCreationOptionsSchema = z.object({
	challenge_id: z.string(),
	challenge: z.string(),
	rp: z.object({ id: z.string().optional(), name: z.string() }),
	user: z.object({ id: z.string(), name: z.string(), displayName: z.string() }),
	pubKeyCredParams: z.array(z.object({ alg: z.number().int(), type: z.literal("public-key") })),
	timeout: z.number().int().optional(),
	excludeCredentials: z.array(CredentialDescriptor).optional(),
	authenticatorSelection: z
		.object({
			authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
			requireResidentKey: z.boolean().optional(),
			residentKey: z.enum(["discouraged", "preferred", "required"]).optional(),
			userVerification: z.enum(["discouraged", "preferred", "required"]).optional(),
		})
		.optional(),
	hints: z.array(z.string()).optional(),
	attestation: z.enum(["direct", "enterprise", "indirect", "none"]).optional(),
	extensions: ExtensionInputs.optional(),
})
export class PasskeyCreationOptionsDto extends zodDto(PasskeyCreationOptionsSchema) {}

export const PasskeyRequestOptionsSchema = z.object({
	challenge_id: z.string(),
	challenge: z.string(),
	timeout: z.number().int().optional(),
	rpId: z.string().optional(),
	allowCredentials: z.array(CredentialDescriptor).optional(),
	userVerification: z.enum(["discouraged", "preferred", "required"]).optional(),
	hints: z.array(z.string()).optional(),
	extensions: ExtensionInputs.optional(),
})
export class PasskeyRequestOptionsDto extends zodDto(PasskeyRequestOptionsSchema) {}

const PasskeyName = z.string().trim().min(1).max(60)
const ChallengeId = z.string().min(1).max(64)

export const PasskeyRegisterBody = z.object({
	challenge_id: ChallengeId,
	credential: RegistrationCredentialSchema,
	/** Defaults to the device label of this browser ("iPhone", "Mac"). */
	name: PasskeyName.optional(),
})
export class PasskeyRegisterDto extends zodDto(PasskeyRegisterBody) {}

export const PasskeyRenameBody = z.object({ name: PasskeyName })
export class PasskeyRenameDto extends zodDto(PasskeyRenameBody) {}

export const PasskeySigninOptionsBody = z.object({ request_id: z.string().max(64).optional() })
export class PasskeySigninOptionsDto extends zodDto(PasskeySigninOptionsBody) {}

export const PasskeyVerifyBody = z.object({
	challenge_id: ChallengeId,
	credential: AuthenticationCredentialSchema,
})
export class PasskeyVerifyDto extends zodDto(PasskeyVerifyBody) {}

export const PasskeySchema = z.object({
	id: z.string(),
	name: z.string(),
	created_at: z.iso.datetime(),
	last_used_at: z.iso.datetime().nullable(),
	device_hint: z.string().nullable(),
	/** Synced passkey (iCloud Keychain, Google Password Manager) rather than device-bound. */
	backed_up: z.boolean(),
})
export class PasskeyDto extends zodDto(PasskeySchema) {}

export const PasskeyListSchema = z.object({ passkeys: z.array(PasskeySchema) })
export class PasskeyListDto extends zodDto(PasskeyListSchema) {}
