// account.controller.ts
// Identity UI backend (oauth.gezcez.com, cookie + CSRF): bootstrap, email-code sign-in and
// sign-up (plan section 7.1).

import { Body, Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Request, Response } from "express"
import type { DeviceContext, SessionContext } from "@common/auth.types"
import {
	ApiEnvelope,
	CurrentDevice,
	CurrentSession,
	RateLimit,
	UseDevice,
	UseSession,
} from "@common/middlewares"
import {
	AccountResultDto,
	CsrfDto,
	DeviceAccountsDto,
	EmailFlowDto,
	EmailResendDto,
	EmailResendResultDto,
	EmailStartDto,
	EmailVerifyDto,
	EmailVerifyResultDto,
	SessionInfoDto,
	SignupCompleteDto,
	SwitchSessionDto,
} from "./account.dto"
import { AccountService } from "./account.service"
import { CsrfService } from "./csrf.service"

@ApiTags("account")
@Controller("account")
export class AccountController {
	constructor(
		private readonly account: AccountService,
		private readonly csrf: CsrfService,
	) {}

	@Get("csrf")
	@UseDevice()
	@ApiOperation({ summary: "CSRF token for X-CSRF-Token (also issues the device cookie)" })
	@ApiEnvelope(CsrfDto)
	getCsrf(
		@CurrentDevice() device: DeviceContext,
		@CurrentSession() session?: SessionContext,
	): CsrfDto {
		return { token: this.csrf.tokenFor(device, session ?? null) }
	}

	@Get("session")
	@UseSession()
	@ApiOperation({ summary: "Current session and account (UI bootstrap)" })
	@ApiEnvelope(SessionInfoDto)
	getSession(@CurrentSession() session: SessionContext): SessionInfoDto {
		return this.account.sessionInfo(session)
	}

	@Get("device-accounts")
	@UseDevice()
	@ApiOperation({ summary: "Accounts remembered on this browser (max 5)" })
	@ApiEnvelope(DeviceAccountsDto)
	deviceAccounts(
		@CurrentDevice() device: DeviceContext,
		@CurrentSession() session?: SessionContext,
	): DeviceAccountsDto {
		return this.account.deviceAccounts(device, session)
	}

	@Post("session/switch")
	@HttpCode(200)
	@UseDevice()
	@ApiOperation({ summary: "Make another live session of this device the active one" })
	@ApiEnvelope(AccountResultDto)
	switchSession(
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response,
		@CurrentDevice() device: DeviceContext,
		@Body() body: SwitchSessionDto,
	): AccountResultDto {
		return this.account.switchSession(req, res, device, body.session_id)
	}

	@Post("email/start")
	@UseDevice()
	@RateLimit("email-code-send")
	@ApiOperation({ summary: "Send an email code (same answer for known and unknown addresses)" })
	@ApiEnvelope(EmailFlowDto, { status: 202 })
	startEmail(@Req() req: Request, @Body() body: EmailStartDto): Promise<EmailFlowDto> {
		return this.account.startEmail(req, body)
	}

	@Post("email/resend")
	@HttpCode(200)
	@UseDevice()
	@RateLimit("email-code-send")
	@ApiOperation({ summary: "Send a new code for a flow (after resend_available_at)" })
	@ApiEnvelope(EmailResendResultDto)
	resendEmail(@Req() req: Request, @Body() body: EmailResendDto): Promise<EmailResendResultDto> {
		return this.account.resendEmail(req, body.flow_id, body.turnstile_token)
	}

	@Post("email/verify")
	@HttpCode(200)
	@UseDevice()
	@RateLimit("email-code-verify")
	@ApiOperation({ summary: "Verify a code: signed_in, needs_profile or reset_ready" })
	@ApiEnvelope(EmailVerifyResultDto)
	verifyEmail(
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response,
		@Body() body: EmailVerifyDto,
	): Promise<EmailVerifyResultDto> {
		return this.account.verifyEmail(req, res, body.flow_id, body.code)
	}

	@Post("signup/complete")
	@HttpCode(200)
	@UseDevice()
	@ApiOperation({ summary: "Create the account after a sign-up code (no username)" })
	@ApiEnvelope(AccountResultDto)
	completeSignup(
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response,
		@Body() body: SignupCompleteDto,
	): Promise<AccountResultDto> {
		return this.account.completeSignup(req, res, body)
	}
}
