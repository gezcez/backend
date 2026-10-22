// flags.controller.ts
// /v1/dash/flags, /v1/dash/settings and the public /v1/system/notice.

import { Body, Controller, Get, Param, Patch, Put, Req } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Request } from "express"
import { ApiEnvelope, Public, UseAuthorization } from "@common/middlewares"
import {
	FlagDetailDto,
	FlagDto,
	FlagListDto,
	FlagUpdateDto,
	SettingsDto,
	SettingsPatchDto,
	SystemNoticeDto,
} from "./flags.dto"
import { FlagsService } from "./flags.service"

@ApiTags("dash")
@Controller("dash")
export class FlagsController {
	constructor(private readonly flags: FlagsService) {}

	@Get("flags")
	@UseAuthorization({ permission: "settings.read", scope: "global", description: "Read flags" })
	@ApiOperation({ summary: "Flags with value, default and last change" })
	@ApiEnvelope(FlagListDto)
	list(): FlagListDto {
		return this.flags.list()
	}

	@Get("flags/:key")
	@UseAuthorization({ permission: "settings.read", scope: "global", description: "Read a flag" })
	@ApiOperation({ summary: "One flag with its change history from the audit log" })
	@ApiEnvelope(FlagDetailDto)
	detail(@Param("key") key: string): FlagDetailDto {
		return this.flags.detail(key)
	}

	@Put("flags/:key")
	@UseAuthorization({ permission: "flags.write", scope: "global", description: "Change a flag" })
	@ApiOperation({
		summary: "Set a flag, or reset it to the default",
		description:
			"The value is validated against the flag's schema. Critical flags need step-up (AUTH_STEP_UP_REQUIRED).",
	})
	@ApiEnvelope(FlagDto)
	set(@Req() req: Request, @Param("key") key: string, @Body() body: FlagUpdateDto): FlagDto {
		return this.flags.set(req, key, body)
	}

	@Get("settings")
	@UseAuthorization({
		permission: "settings.read",
		scope: "global",
		description: "Read settings",
	})
	@ApiOperation({ summary: "Settings groups" })
	@ApiEnvelope(SettingsDto)
	settings(): SettingsDto {
		return this.flags.settings()
	}

	@Patch("settings")
	@UseAuthorization({
		permission: "settings.write",
		scope: "global",
		sudo: true,
		description: "Change settings",
	})
	@ApiOperation({ summary: "Replace the given settings groups (step-up)" })
	@ApiEnvelope(SettingsDto)
	updateSettings(@Req() req: Request, @Body() body: SettingsPatchDto): SettingsDto {
		return this.flags.updateSettings(req, body)
	}
}

@ApiTags("system")
@Controller("system")
export class SystemNoticeController {
	constructor(private readonly flags: FlagsService) {}

	@Get("notice")
	@Public()
	@ApiOperation({ summary: "Maintenance banner and whether sign-up is open (web apps)" })
	@ApiEnvelope(SystemNoticeDto)
	notice(): SystemNoticeDto {
		const { signup, maintenance } = this.flags.settings()
		return {
			maintenance: maintenance.enabled ? { message: maintenance.message } : null,
			signup_open: signup.open,
		}
	}
}
