// token.controller.ts
// RFC 6749 token endpoint and RFC 7009 revocation: form or JSON bodies, RFC shaped responses and
// errors (outside the envelope). The body is parsed by TokenService so a malformed request is an
// `invalid_request`, not a VALIDATION_FAILED envelope.

import { applyDecorators, Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common"
import { ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger"
import type { Request, Response } from "express"
import { ApiEnvelope, Public, RateLimit, RawResponse } from "@common/middlewares"
import { OAuthErrorDto, RevokeRequestDto, TokenRequestDto, TokenResponseDto } from "./oauth.dto"
import { TokenService } from "./token.service"

const OAuthErrors = () =>
	applyDecorators(
		ApiResponse({ status: 400, description: "RFC 6749 error", type: OAuthErrorDto }),
		ApiResponse({ status: 401, description: "invalid_client", type: OAuthErrorDto }),
	)

@ApiTags("oauth")
@Public()
@RawResponse()
@Controller("oauth")
export class TokenController {
	constructor(private readonly tokens: TokenService) {}

	@Post("token")
	@HttpCode(200)
	@RateLimit("token")
	@ApiOperation({
		summary: "authorization_code and refresh_token grants",
		description:
			"Cookie clients (refresh_cookie) get the refresh token as the gz_rt cookie " +
			"(Path=/v1/oauth) and may refresh with an empty body.",
	})
	@ApiConsumes("application/x-www-form-urlencoded", "application/json")
	@ApiBody({ type: TokenRequestDto })
	@ApiEnvelope(TokenResponseDto, { raw: true })
	@OAuthErrors()
	token(
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response,
		@Body() body: Record<string, unknown> | undefined,
	): Promise<TokenResponseDto> {
		return this.tokens.token(req, res, body ?? {})
	}

	@Post("revoke")
	@HttpCode(200)
	@RateLimit("token")
	@ApiOperation({ summary: "Revoke a refresh token family (RFC 7009)" })
	@ApiConsumes("application/x-www-form-urlencoded", "application/json")
	@ApiBody({ type: RevokeRequestDto })
	@ApiResponse({ status: 200, description: "Revoked, or the token was unknown" })
	@OAuthErrors()
	revoke(
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response,
		@Body() body: Record<string, unknown> | undefined,
	): Record<string, never> {
		this.tokens.revoke(req, res, body ?? {})
		res.setHeader("Cache-Control", "no-store")
		return {}
	}
}
