// oauth.dto.ts
// Shapes of oauth.md section 4.2 (authorization request) and the RFC 6749 / 7009 bodies.

import { zodDto } from "@common/response"
import { z } from "zod"

export const ClientInfoSchema = z.object({
	client_id: z.string(),
	name: z.string(),
	logo_url: z.string().optional(),
	homepage_url: z.string().optional(),
	first_party: z.boolean(),
	type: z.enum(["public", "confidential"]),
})
export class ClientInfoDto extends zodDto(ClientInfoSchema) {}

export const ScopeInfoSchema = z.object({ key: z.string(), i18n_key: z.string() })

export const AppInfoSchema = ClientInfoSchema.extend({ scopes: z.array(ScopeInfoSchema) })
export class AppInfoDto extends zodDto(AppInfoSchema) {}

export const ScopeListSchema = z.object({ scopes: z.array(ScopeInfoSchema) })
export class ScopeListDto extends zodDto(ScopeListSchema) {}

export const NextStep = z.enum(["redirect", "login", "reauth", "choose_account", "consent"])
export type NextStep = z.infer<typeof NextStep>

export const AuthorizeBody = z.object({
	/** The raw /authorize query, untouched. */
	params: z.record(z.string(), z.string().max(2048)),
})
export class AuthorizeDto extends zodDto(AuthorizeBody) {}

export const AuthorizeSnapshotSchema = z.object({
	/** Null only when the request was rejected straight away with an error redirect. */
	request_id: z.string().nullable(),
	client: ClientInfoSchema,
	scopes: z.array(ScopeInfoSchema),
	prompt: z.string().optional(),
	login_hint: z.string().optional(),
	ui_locales: z.string().optional(),
	next: NextStep,
	/** Present when `next` is `redirect`: the code (or an OAuth error) plus `state`. */
	redirect_to: z.string().optional(),
})
export class AuthorizeSnapshotDto extends zodDto(AuthorizeSnapshotSchema) {}

export const AuthorizeContinueBody = z.object({ session_id: z.string().max(64).optional() })
export class AuthorizeContinueDto extends zodDto(AuthorizeContinueBody) {}

export const AuthorizeNextSchema = z.object({
	next: NextStep,
	redirect_to: z.string().optional(),
})
export class AuthorizeNextDto extends zodDto(AuthorizeNextSchema) {}

export const AuthorizeDecisionBody = z.object({ decision: z.enum(["approve", "deny"]) })
export class AuthorizeDecisionDto extends zodDto(AuthorizeDecisionBody) {}

export const RedirectSchema = z.object({ redirect_to: z.string() })
export class RedirectDto extends zodDto(RedirectSchema) {}

export const LogoutBody = z.object({
	scope: z.enum(["session", "device"]).default("session"),
	client_id: z.string().max(128).optional(),
	post_logout_redirect_uri: z.string().max(2048).optional(),
	state: z.string().max(512).optional(),
})
export class LogoutDto extends zodDto(LogoutBody) {}

export const LogoutResultSchema = z.object({
	/** False when the redirect URI was not registered: the UI asks the user to confirm first. */
	signed_out: z.boolean(),
	redirect_to: z.string().optional(),
})
export class LogoutResultDto extends zodDto(LogoutResultSchema) {}

// RFC 6749 section 5.1 / 7009. Documented only; the token controller parses the body itself so
// errors keep the RFC shape.

export const TokenRequestSchema = z.object({
	grant_type: z.enum(["authorization_code", "refresh_token"]).optional(),
	code: z.string().optional(),
	redirect_uri: z.string().optional(),
	code_verifier: z.string().optional(),
	refresh_token: z.string().optional(),
	client_id: z.string().optional(),
	client_secret: z.string().optional(),
	scope: z.string().optional(),
})
export class TokenRequestDto extends zodDto(TokenRequestSchema) {}

export const TokenResponseSchema = z.object({
	access_token: z.string(),
	token_type: z.literal("Bearer"),
	expires_in: z.number().int(),
	/** Omitted for cookie clients (gz_rt) and without offline_access. */
	refresh_token: z.string().optional(),
	scope: z.string(),
})
export class TokenResponseDto extends zodDto(TokenResponseSchema) {}

export const RevokeRequestSchema = z.object({
	token: z.string().optional(),
	token_type_hint: z.string().optional(),
	client_id: z.string().optional(),
	client_secret: z.string().optional(),
})
export class RevokeRequestDto extends zodDto(RevokeRequestSchema) {}

export const OAuthErrorSchema = z.object({
	error: z.string(),
	error_description: z.string().optional(),
})
export class OAuthErrorDto extends zodDto(OAuthErrorSchema) {}
