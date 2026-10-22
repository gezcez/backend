// oauth.controller.ts
// Client display info, scopes, the server-side authorization request (oauth.md section 4.2) and
// RP-initiated logout. The protocol endpoints (token, revoke) live in token.controller.ts.

import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Request, Response } from "express"
import { ApiEnvelope, Public, UseDevice, UseSession } from "@common/middlewares"
import { SCOPE_KEYS } from "@common/scopes"
import { AuthorizeService } from "./authorize.service"
import { ClientsService, scopeInfo } from "./clients.service"
import {
	AppInfoDto,
	AuthorizeContinueDto,
	AuthorizeDecisionDto,
	AuthorizeDto,
	AuthorizeNextDto,
	AuthorizeSnapshotDto,
	LogoutDto,
	LogoutResultDto,
	ScopeListDto,
} from "./oauth.dto"
import { TokenService } from "./token.service"

@ApiTags("oauth")
@Controller("oauth")
export class OAuthController {
	constructor(
		private readonly clients: ClientsService,
		private readonly authorize: AuthorizeService,
		private readonly tokens: TokenService,
	) {}

	@Get("apps/:clientId")
	@Public()
	@ApiOperation({ summary: "Client name, logo, scopes and first_party (display only)" })
	@ApiEnvelope(AppInfoDto)
	app(@Param("clientId") clientId: string): AppInfoDto {
		return this.clients.publicInfo(clientId)
	}

	@Get("scopes")
	@Public()
	@ApiOperation({ summary: "Scope keys with i18n keys" })
	@ApiEnvelope(ScopeListDto)
	scopes(): ScopeListDto {
		return { scopes: scopeInfo([...SCOPE_KEYS]) }
	}

	@Post("authorize")
	@HttpCode(200)
	@UseDevice()
	@ApiOperation({
		summary: "Create the authorization request from the raw /authorize query",
		description:
			"Client and redirect URI failures are errors (never redirected); later failures come " +
			"back as next=redirect with an OAuth error redirect_to.",
	})
	@ApiEnvelope(AuthorizeSnapshotDto)
	start(@Req() req: Request, @Body() body: AuthorizeDto): AuthorizeSnapshotDto {
		return this.authorize.start(req, body.params)
	}

	@Get("authorize/:requestId")
	@UseDevice()
	@ApiOperation({ summary: "Re-fetch the authorization request, next recomputed" })
	@ApiEnvelope(AuthorizeSnapshotDto)
	get(@Req() req: Request, @Param("requestId") requestId: string): AuthorizeSnapshotDto {
		return this.authorize.get(req, requestId)
	}

	@Post("authorize/:requestId/continue")
	@HttpCode(200)
	@UseSession()
	@ApiOperation({ summary: "Continue after sign-in or account choice" })
	@ApiEnvelope(AuthorizeNextDto)
	continue(
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response,
		@Param("requestId") requestId: string,
		@Body() body: AuthorizeContinueDto,
	): AuthorizeNextDto {
		return this.authorize.continue(req, res, requestId, body.session_id)
	}

	@Post("authorize/:requestId/decision")
	@HttpCode(200)
	@UseSession()
	@ApiOperation({ summary: "Consent answer (third-party clients)" })
	@ApiEnvelope(AuthorizeNextDto)
	decision(
		@Req() req: Request,
		@Param("requestId") requestId: string,
		@Body() body: AuthorizeDecisionDto,
	): AuthorizeNextDto {
		return this.authorize.decision(req, requestId, body.decision)
	}

	@Post("logout")
	@HttpCode(200)
	@UseDevice()
	@ApiOperation({
		summary: "End the SSO session (scope session) or every session of this browser (device)",
	})
	@ApiEnvelope(LogoutResultDto)
	logout(
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response,
		@Body() body: LogoutDto,
	): LogoutResultDto {
		return this.tokens.logout(req, res, body)
	}
}
