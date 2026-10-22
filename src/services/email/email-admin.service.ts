// email-admin.service.ts
// Dashboard email pages (plan 6.13): templates with sample variables and server-side previews,
// the delivery log with masked recipients, suppressions, and test sends.

import { Injectable } from "@nestjs/common"
import type { Request } from "express"
import { hasPermission } from "@common/authorization"
import { GezcezError } from "@common/errors"
import type { Page } from "@common/response"
import { maskEmail } from "@common/utils"
import { LOCALES } from "@lang"
import type { EmailRow, EmailSuppressionRow } from "@schemas/core"
import { AuditService } from "@services/audit/audit.service"
import { RefsService } from "@services/refs/refs.service"
import { PermissionCacheService } from "@services/roles/permission-cache.service"
import type {
	EmailDelivery,
	EmailDeliveryQueryDto,
	EmailPreviewDto,
	EmailPreviewRequestDto,
	EmailSuppression,
	EmailSuppressionQueryDto,
	EmailTemplate,
	EmailTestRequestDto,
	EmailTestResultDto,
	UserEmailQueryDto,
} from "./email-admin.dto"
import { EmailAdminRepository } from "./email-admin.repository"
import { EmailService } from "./email.service"
import {
	isTemplateKey,
	renderTemplate,
	TEMPLATE_CATALOG,
	TEMPLATE_KEYS,
	templateVarsFrom,
	type TemplateKey,
} from "./email.templates"

@Injectable()
export class EmailAdminService {
	constructor(
		private readonly repository: EmailAdminRepository,
		private readonly email: EmailService,
		private readonly refs: RefsService,
		private readonly permissions: PermissionCacheService,
		private readonly audit: AuditService,
	) {}

	templates(): EmailTemplate[] {
		return TEMPLATE_KEYS.map((key) => ({
			key,
			description: TEMPLATE_CATALOG[key].description,
			locales: [...LOCALES],
			variables: TEMPLATE_CATALOG[key].variables,
		}))
	}

	preview(key: string, body: EmailPreviewRequestDto): EmailPreviewDto {
		const template = this.template(key)
		return renderTemplate(template, body.locale, templateVarsFrom(template, body.variables))
	}

	deliveries(query: EmailDeliveryQueryDto): Page<EmailDelivery> {
		return this.presentDeliveries(
			this.repository.deliveries({ status: query.status, template: query.template }, query),
		)
	}

	userDeliveries(publicId: string, query: UserEmailQueryDto): Page<EmailDelivery> {
		const userId = this.refs.userId(publicId)
		return this.presentDeliveries(this.repository.deliveries({ userId }, query))
	}

	suppressions(query: EmailSuppressionQueryDto): Page<EmailSuppression> {
		const page = this.repository.suppressions({ reason: query.reason }, query)
		return { ...page, items: page.items.map(presentSuppression) }
	}

	removeSuppression(req: Request, id: string, reason: string): { deleted: boolean } {
		const row = this.repository.findActiveSuppression(id)
		if (!row) throw new GezcezError("NOT_FOUND", "Suppression not found")
		this.repository.removeSuppression(id, req.auth!.userId, reason, new Date())
		this.audit.record("email.suppression_removed", {
			req,
			target: { type: "email", id: row.email_masked ?? "***" },
			data: { before: { reason: row.reason }, after: { removed_reason: reason } },
		})
		return { deleted: true }
	}

	async sendTest(req: Request, body: EmailTestRequestDto): Promise<EmailTestResultDto> {
		const template = this.template(body.template)
		const userId = req.auth!.userId
		if (
			body.to !== undefined &&
			!hasPermission(this.permissions.forUser(userId), "email.test.send.any")
		)
			throw new GezcezError(
				"PERMISSION_MISSING",
				"Sending to any address needs email.test.send.any",
				{
					permission: "email.test.send.any",
				},
			)
		const to = body.to ?? this.repository.userEmail(userId)
		if (!to) throw new GezcezError("NOT_FOUND", "No address for the caller")
		const { id, done } = this.email.send(
			template,
			to,
			body.locale,
			templateVarsFrom(template),
			{ userId: body.to === undefined ? userId : null, subjectPrefix: "[TEST] " },
		)
		await done
		this.audit.record("email.test_sent", {
			req,
			target: { type: "email", id },
			data: {
				after: {
					template,
					locale: body.locale,
					to_masked: maskEmail(to),
					own_address: body.to === undefined,
				},
			},
		})
		return { delivery_id: id, to_masked: maskEmail(to) }
	}

	private template(key: string): TemplateKey {
		if (!isTemplateKey(key)) throw new GezcezError("NOT_FOUND", "Template not found")
		return key
	}

	private presentDeliveries(page: Page<EmailRow>): Page<EmailDelivery> {
		const users = this.refs.users(page.items.map((row) => row.user_id))
		return {
			...page,
			items: page.items.map((row) => ({
				id: row.id,
				template: row.template,
				subject: row.subject,
				to_masked: maskEmail(row.to_email),
				locale: row.locale === "en" ? "en" : "tr",
				status: row.status,
				user: row.user_id === null ? null : (users.get(row.user_id) ?? null),
				attempts: row.attempts,
				last_error: row.last_error,
				created_at: row.created_at.toISOString(),
				updated_at: (row.updated_at ?? row.sent_at ?? row.created_at).toISOString(),
			})),
		}
	}
}

function presentSuppression(row: EmailSuppressionRow): EmailSuppression {
	return {
		id: row.email_hash,
		email_masked: row.email_masked ?? "***",
		reason: row.reason,
		detail: row.detail,
		created_at: row.created_at.toISOString(),
	}
}
