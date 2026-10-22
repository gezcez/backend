// email-admin.controller.ts
// /v1/dash/email/* and /v1/dash/users/:userId/emails (plan 7.2).

import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Request } from "express"
import { ApiEnvelope, UseAuthorization } from "@common/middlewares"
import { DeletedDto } from "@services/roles/roles.dto"
import {
	EmailDeliveryPageDto,
	EmailDeliveryQueryDto,
	EmailPreviewDto,
	EmailPreviewRequestDto,
	EmailSuppressionPageDto,
	EmailSuppressionQueryDto,
	EmailTemplateListDto,
	EmailTestRequestDto,
	EmailTestResultDto,
	SuppressionDeleteDto,
	UserEmailQueryDto,
} from "./email-admin.dto"
import { EmailAdminService } from "./email-admin.service"

@ApiTags("dash")
@Controller("dash")
export class EmailAdminController {
	constructor(private readonly emails: EmailAdminService) {}

	@Get("email/templates")
	@UseAuthorization({
		permission: "email.read",
		scope: "global",
		description: "List email templates",
	})
	@ApiOperation({ summary: "Template keys, locales and variables with sample values" })
	@ApiEnvelope(EmailTemplateListDto)
	templates(): EmailTemplateListDto {
		return this.emails.templates()
	}

	@Post("email/templates/:key/preview")
	@HttpCode(200)
	@UseAuthorization({
		permission: "email.read",
		scope: "global",
		description: "Preview an email template",
	})
	@ApiOperation({
		summary: "Render a template server-side",
		description: "Variables left out take the template's sample values. Nothing is sent.",
	})
	@ApiEnvelope(EmailPreviewDto)
	preview(@Param("key") key: string, @Body() body: EmailPreviewRequestDto): EmailPreviewDto {
		return this.emails.preview(key, body)
	}

	@Get("email/deliveries")
	@UseAuthorization({
		permission: "email.read",
		scope: "global",
		description: "Read the email log",
	})
	@ApiOperation({
		summary: "Email log, recipients masked",
		description:
			"`q` matches the id, a subject substring or a template prefix. Sort: created_at, updated_at.",
	})
	@ApiEnvelope(EmailDeliveryPageDto)
	deliveries(@Query() query: EmailDeliveryQueryDto): EmailDeliveryPageDto {
		return this.emails.deliveries(query)
	}

	@Get("users/:userId/emails")
	@UseAuthorization({
		permission: "email.read",
		scope: "global",
		description: "Read emails sent to a user",
	})
	@ApiOperation({ summary: "Deliveries to one user (metadata only)" })
	@ApiEnvelope(EmailDeliveryPageDto)
	userEmails(
		@Param("userId") userId: string,
		@Query() query: UserEmailQueryDto,
	): EmailDeliveryPageDto {
		return this.emails.userDeliveries(userId, query)
	}

	@Get("email/suppressions")
	@UseAuthorization({
		permission: "email.read",
		scope: "global",
		description: "Read email suppressions",
	})
	@ApiOperation({ summary: "Suppressed addresses (masked); `q` matches the masked address" })
	@ApiEnvelope(EmailSuppressionPageDto)
	suppressions(@Query() query: EmailSuppressionQueryDto): EmailSuppressionPageDto {
		return this.emails.suppressions(query)
	}

	@Delete("email/suppressions/:id")
	@UseAuthorization({
		permission: "settings.write",
		scope: "global",
		description: "Remove an email suppression",
	})
	@ApiOperation({ summary: "Remove a suppression with a reason (audited)" })
	@ApiEnvelope(DeletedDto)
	removeSuppression(
		@Req() req: Request,
		@Param("id") id: string,
		@Body() body: SuppressionDeleteDto,
	): DeletedDto {
		return this.emails.removeSuppression(req, id, body.reason)
	}

	@Post("email/test")
	@HttpCode(200)
	@UseAuthorization({
		permission: "email.test.send",
		scope: "global",
		description: "Send a test email",
	})
	@ApiOperation({
		summary: "Send a test email with sample variables",
		description:
			"Goes to the caller's own address unless `to` is given, which needs email.test.send.any. The subject starts with [TEST].",
	})
	@ApiEnvelope(EmailTestResultDto)
	sendTest(@Req() req: Request, @Body() body: EmailTestRequestDto): Promise<EmailTestResultDto> {
		return this.emails.sendTest(req, body)
	}
}
