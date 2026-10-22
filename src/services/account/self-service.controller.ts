// self-service.controller.ts
// Account pages on the identity session (cookie + CSRF on writes), oauth.md section 4.4.

import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	Patch,
	Post,
	Req,
	Res,
} from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Request, Response } from "express"
import type { SessionContext } from "@common/auth.types"
import { ApiEmpty, ApiEnvelope, CurrentSession, UseSession } from "@common/middlewares"
import {
	AuthorizedAppsDto,
	EmailChangeDto,
	EmailChangeResultDto,
	EmailFlowDto,
	EmailVerifyDto,
	PrivacyDto,
	PrivacyPatchDto,
	ProfileDto,
	ProfilePatchDto,
	RevokedCountDto,
	SecurityDto,
	SessionListDto,
} from "./account.dto"
import { AccountService } from "./account.service"
import { SelfServiceService } from "./self-service.service"

@ApiTags("account")
@Controller("account")
export class SelfServiceController {
	constructor(
		private readonly selfService: SelfServiceService,
		private readonly account: AccountService,
	) {}

	@Get("profile")
	@UseSession()
	@ApiOperation({ summary: "Account details" })
	@ApiEnvelope(ProfileDto)
	profile(@CurrentSession() session: SessionContext): ProfileDto {
		return this.selfService.profile(session.userId)
	}

	@Patch("profile")
	@UseSession()
	@ApiOperation({ summary: "Change display name or locale" })
	@ApiEnvelope(ProfileDto)
	updateProfile(
		@CurrentSession() session: SessionContext,
		@Body() body: ProfilePatchDto,
	): ProfileDto {
		return this.selfService.updateProfile(session.userId, body)
	}

	@Post("email/change")
	@UseSession({ stepUp: true })
	@ApiOperation({ summary: "Start an email change: a code to the new address (step-up)" })
	@ApiEnvelope(EmailFlowDto, { status: 202 })
	startEmailChange(@Req() req: Request, @Body() body: EmailChangeDto): Promise<EmailFlowDto> {
		return this.account.startEmailChange(req, body)
	}

	@Post("email/change/verify")
	@HttpCode(200)
	@UseSession({ stepUp: true })
	@ApiOperation({ summary: "Confirm the new address; the old one gets a notice (step-up)" })
	@ApiEnvelope(EmailChangeResultDto)
	verifyEmailChange(@Req() req: Request, @Body() body: EmailVerifyDto): EmailChangeResultDto {
		return this.account.verifyEmailChange(req, body.flow_id, body.code)
	}

	@Get("sessions")
	@UseSession()
	@ApiOperation({ summary: "Own sessions with device label, approximate location and apps" })
	@ApiEnvelope(SessionListDto)
	sessions(@Req() req: Request): SessionListDto {
		return this.selfService.listSessions(req)
	}

	@Delete("sessions/:sessionId")
	@UseSession()
	@ApiOperation({ summary: "Revoke one session and its refresh families" })
	@ApiEmpty()
	revokeSession(
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response,
		@Param("sessionId") sessionId: string,
	): null {
		this.selfService.revokeSession(req, res, sessionId)
		return null
	}

	@Post("sessions/revoke-others")
	@HttpCode(200)
	@UseSession({ stepUp: true })
	@ApiOperation({ summary: "Sign out everywhere else (step-up)" })
	@ApiEnvelope(RevokedCountDto)
	revokeOthers(@Req() req: Request): RevokedCountDto {
		return this.selfService.revokeOtherSessions(req)
	}

	@Get("apps")
	@UseSession()
	@ApiOperation({ summary: "Authorized apps (grants and active tokens)" })
	@ApiEnvelope(AuthorizedAppsDto)
	apps(@CurrentSession() session: SessionContext): AuthorizedAppsDto {
		return this.selfService.authorizedApps(session.userId)
	}

	@Delete("apps/:clientId")
	@UseSession()
	@ApiOperation({ summary: "Revoke an app's grant and its refresh tokens" })
	@ApiEmpty()
	revokeApp(@Req() req: Request, @Param("clientId") clientId: string): null {
		this.selfService.revokeApp(req, clientId)
		return null
	}

	@Get("security")
	@UseSession()
	@ApiOperation({ summary: "Sign-in methods and the last 20 security events" })
	@ApiEnvelope(SecurityDto)
	security(@CurrentSession() session: SessionContext): SecurityDto {
		return this.selfService.security(session.userId)
	}

	@Get("privacy")
	@UseSession()
	@ApiOperation({ summary: "Privacy toggles" })
	@ApiEnvelope(PrivacyDto)
	privacy(@CurrentSession() session: SessionContext): PrivacyDto {
		return this.selfService.privacy(session.userId)
	}

	@Patch("privacy")
	@UseSession()
	@ApiOperation({ summary: "Change privacy toggles" })
	@ApiEnvelope(PrivacyDto)
	updatePrivacy(
		@CurrentSession() session: SessionContext,
		@Body() body: PrivacyPatchDto,
	): PrivacyDto {
		return this.selfService.updatePrivacy(session.userId, body)
	}
}
