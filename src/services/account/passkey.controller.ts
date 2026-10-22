// passkey.controller.ts
// Passkeys (P5): registration and management behind step-up, sign-in with a discoverable
// credential, and passkey re-auth of the current session (oauth.md sections 4.3, 4.4, 5.11).

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, Res } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Request, Response } from "express"
import type { SessionContext } from "@common/auth.types"
import {
	ApiEmpty,
	ApiEnvelope,
	CurrentSession,
	RateLimit,
	UseDevice,
	UseSession,
} from "@common/middlewares"
import {
	PasskeyCreationOptionsDto,
	PasskeyDto,
	PasskeyListDto,
	PasskeyRegisterDto,
	PasskeyRenameDto,
	PasskeyRequestOptionsDto,
	PasskeySigninOptionsDto,
	PasskeyVerifyDto,
	SignedInDto,
} from "./account.dto"
import { PasskeyService } from "./passkey.service"

@ApiTags("account")
@Controller("account/passkeys")
export class PasskeyController {
	constructor(private readonly passkeys: PasskeyService) {}

	@Get()
	@UseSession()
	@ApiOperation({ summary: "The account's passkeys" })
	@ApiEnvelope(PasskeyListDto)
	list(@CurrentSession() session: SessionContext): PasskeyListDto {
		return this.passkeys.list(session.userId)
	}

	@Post("options")
	@HttpCode(200)
	@UseSession({ stepUp: true })
	@ApiOperation({
		summary: "Registration options (PublicKeyCredentialCreationOptionsJSON) (step-up)",
	})
	@ApiEnvelope(PasskeyCreationOptionsDto)
	registrationOptions(@Req() req: Request): Promise<PasskeyCreationOptionsDto> {
		return this.passkeys.registrationOptions(req)
	}

	@Post()
	@UseSession({ stepUp: true })
	@ApiOperation({ summary: "Verify the attestation and save the passkey (step-up)" })
	@ApiEnvelope(PasskeyDto, { status: 201 })
	register(@Req() req: Request, @Body() body: PasskeyRegisterDto): Promise<PasskeyDto> {
		return this.passkeys.register(req, body)
	}

	@Post("signin/options")
	@HttpCode(200)
	@UseDevice()
	@RateLimit("passkey")
	@ApiOperation({
		summary: "Sign-in options for a discoverable passkey (PublicKeyCredentialRequestOptionsJSON)",
	})
	@ApiEnvelope(PasskeyRequestOptionsDto)
	signinOptions(
		@Req() req: Request,
		@Body() body: PasskeySigninOptionsDto,
	): Promise<PasskeyRequestOptionsDto> {
		return this.passkeys.signinOptions(req, body.request_id)
	}

	@Post("signin/verify")
	@HttpCode(200)
	@UseDevice()
	@RateLimit("passkey")
	@ApiOperation({ summary: "Sign in with a passkey; sets gz_session with amr webauthn" })
	@ApiEnvelope(SignedInDto)
	signinVerify(
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response,
		@Body() body: PasskeyVerifyDto,
	): Promise<SignedInDto> {
		return this.passkeys.signinVerify(req, res, body)
	}

	@Post("reauth/options")
	@HttpCode(200)
	@UseSession()
	@RateLimit("passkey")
	@ApiOperation({ summary: "Re-auth options limited to this account's passkeys" })
	@ApiEnvelope(PasskeyRequestOptionsDto)
	reauthOptions(@Req() req: Request): Promise<PasskeyRequestOptionsDto> {
		return this.passkeys.reauthOptions(req)
	}

	@Post("reauth/verify")
	@HttpCode(200)
	@UseSession()
	@RateLimit("passkey")
	@ApiOperation({ summary: "Re-verify with a passkey; refreshes auth_time and amr" })
	@ApiEnvelope(SignedInDto)
	reauthVerify(@Req() req: Request, @Body() body: PasskeyVerifyDto): Promise<SignedInDto> {
		return this.passkeys.reauthVerify(req, body)
	}

	@Patch(":passkeyId")
	@UseSession({ stepUp: true })
	@ApiOperation({ summary: "Rename a passkey (step-up)" })
	@ApiEnvelope(PasskeyDto)
	rename(
		@Req() req: Request,
		@Param("passkeyId") passkeyId: string,
		@Body() body: PasskeyRenameDto,
	): PasskeyDto {
		return this.passkeys.rename(req, passkeyId, body.name)
	}

	@Delete(":passkeyId")
	@UseSession({ stepUp: true })
	@ApiOperation({ summary: "Remove a passkey; email codes stay as recovery (step-up)" })
	@ApiEmpty()
	remove(@Req() req: Request, @Param("passkeyId") passkeyId: string): null {
		this.passkeys.remove(req, passkeyId)
		return null
	}
}
