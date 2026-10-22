// well-known.dto.ts

import { zodDto } from "@common/response"
import { z } from "zod"

export const JwksSchema = z.object({
	keys: z.array(
		z.object({
			kty: z.string(),
			crv: z.string(),
			x: z.string(),
			y: z.string(),
			kid: z.string(),
			alg: z.literal("ES256"),
			use: z.literal("sig"),
		}),
	),
})
export class JwksDto extends zodDto(JwksSchema) {}

export const OpenIdConfigurationSchema = z.object({
	issuer: z.string(),
	authorization_endpoint: z.string(),
	token_endpoint: z.string(),
	revocation_endpoint: z.string(),
	end_session_endpoint: z.string(),
	jwks_uri: z.string(),
	userinfo_endpoint: z.string(),
	scopes_supported: z.array(z.string()),
	response_types_supported: z.array(z.string()),
	response_modes_supported: z.array(z.string()),
	grant_types_supported: z.array(z.string()),
	code_challenge_methods_supported: z.array(z.string()),
	token_endpoint_auth_methods_supported: z.array(z.string()),
	subject_types_supported: z.array(z.string()),
	id_token_signing_alg_values_supported: z.array(z.string()),
	claims_supported: z.array(z.string()),
	prompt_values_supported: z.array(z.string()),
	ui_locales_supported: z.array(z.string()),
})
export class OpenIdConfigurationDto extends zodDto(OpenIdConfigurationSchema) {}
