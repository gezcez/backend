// well-known.controller.ts
// Issuer metadata and JWKS (RFC 8414 / RFC 7517 shapes, outside the envelope and the /v1 prefix).

import { Controller, Get, Header } from "@nestjs/common"
import { ApiTags } from "@nestjs/swagger"
import { SkipThrottle } from "@nestjs/throttler"
import { InjectConfig, type AppConfig } from "@common/config"
import { ApiEnvelope, Public, RawResponse } from "@common/middlewares"
import { SCOPE_KEYS } from "@common/scopes"
import { KeysService } from "./keys.service"
import { JwksDto, OpenIdConfigurationDto } from "./well-known.dto"

@ApiTags("oauth")
@Public()
@SkipThrottle()
@RawResponse()
@Controller(".well-known")
export class WellKnownController {
	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly keys: KeysService,
	) {}

	@Get("openid-configuration")
	@Header("Cache-Control", "public, max-age=300")
	@ApiEnvelope(OpenIdConfigurationDto, { raw: true })
	openidConfiguration(): OpenIdConfigurationDto {
		const api = this.config.publicApiUrl
		return {
			issuer: this.config.issuer,
			authorization_endpoint: `${this.config.oauthUiUrl}/authorize`,
			token_endpoint: `${api}/v1/oauth/token`,
			revocation_endpoint: `${api}/v1/oauth/revoke`,
			end_session_endpoint: `${this.config.oauthUiUrl}/logout`,
			jwks_uri: `${api}/.well-known/jwks.json`,
			userinfo_endpoint: `${api}/v1/me`,
			scopes_supported: [...SCOPE_KEYS],
			response_types_supported: ["code"],
			response_modes_supported: ["query"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: [
				"none",
				"client_secret_basic",
				"client_secret_post",
			],
			subject_types_supported: ["public"],
			id_token_signing_alg_values_supported: ["ES256"],
			claims_supported: [
				"iss",
				"sub",
				"aud",
				"exp",
				"iat",
				"auth_time",
				"amr",
				"sid",
				"scope",
			],
			prompt_values_supported: ["none", "login", "consent", "select_account"],
			ui_locales_supported: ["tr", "en"],
		}
	}

	@Get("jwks.json")
	@Header("Cache-Control", "public, max-age=300")
	@ApiEnvelope(JwksDto, { raw: true })
	jwks(): JwksDto {
		return this.keys.jwks() as JwksDto
	}
}
