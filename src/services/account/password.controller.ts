// password.controller.ts
// Optional password method: login, reset with reset_token, password re-auth, set and remove.

import { Body, Controller, Delete, HttpCode, Post, Put, Req, Res } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Request, Response } from "express"
import { ApiEmpty, ApiEnvelope, UseDevice, UseSession } from "@common/middlewares"
import {
	PasswordLoginDto,
	PasswordResetDto,
	PasswordSetDto,
	ReauthDto,
	SignedInDto,
} from "./account.dto"
import { PasswordService } from "./password.service"

@ApiTags("account")
@Controller("account")
export class PasswordController {
	constructor(private readonly passwords: PasswordService) {}

	@Post("password/login")
	@HttpCode(200)
	@UseDevice()
	@ApiOperation({ summary: "Password login (optional method, Turnstile, fails closed)" })
	@ApiEnvelope(SignedInDto)
	login(
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response,
		@Body() body: PasswordLoginDto,
	): Promise<SignedInDto> {
		return this.passwords.login(req, res, body)
	}

	@Post("password/reset")
	@HttpCode(200)
	@UseDevice()
	@ApiOperation({ summary: "Set a new password with reset_token; revokes every session" })
	@ApiEnvelope(SignedInDto)
	reset(
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response,
		@Body() body: PasswordResetDto,
	): Promise<SignedInDto> {
		return this.passwords.reset(req, res, body)
	}

	@Post("reauth")
	@HttpCode(200)
	@UseSession()
	@ApiOperation({ summary: "Re-verify with the password; refreshes auth_time and amr" })
	@ApiEnvelope(SignedInDto)
	reauth(
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response,
		@Body() body: ReauthDto,
	): Promise<SignedInDto> {
		return this.passwords.reauth(req, res, body.password)
	}

	@Put("password")
	@UseSession({ stepUp: true })
	@ApiOperation({ summary: "Set or change the password (step-up)" })
	@ApiEmpty()
	async set(@Req() req: Request, @Body() body: PasswordSetDto): Promise<null> {
		await this.passwords.set(req, body)
		return null
	}

	@Delete("password")
	@UseSession({ stepUp: true })
	@ApiOperation({ summary: "Remove the password, back to email codes only (step-up)" })
	@ApiEmpty()
	remove(@Req() req: Request): null {
		this.passwords.remove(req)
		return null
	}
}
