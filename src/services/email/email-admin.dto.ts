// email-admin.dto.ts

import { z } from "zod"
import { DateTime, LocaleRef, ReasonSchema, UserRefSchema } from "@common/models/dash.models"
import { pageSchema, PageQuerySchema, zodDto } from "@common/response"

export const EmailStatusSchema = z
	.enum(["queued", "sent", "delivered", "bounced", "complained", "failed"])
	.meta({ id: "EmailStatus" })

export const EmailTemplateSchema = z
	.object({
		key: z.string(),
		description: z.string(),
		locales: z.array(LocaleRef),
		variables: z.array(
			z.object({ name: z.string(), description: z.string(), example: z.string() }),
		),
	})
	.meta({ id: "EmailTemplate" })
export type EmailTemplate = z.infer<typeof EmailTemplateSchema>

export class EmailTemplateListDto extends zodDto(z.array(EmailTemplateSchema)) {}

export class EmailPreviewRequestDto extends zodDto(
	z.object({
		locale: LocaleRef,
		/** Missing variables take the template's sample values. */
		variables: z.record(z.string(), z.string().max(500)).default({}),
	}),
) {}

export class EmailPreviewDto extends zodDto(
	z.object({ subject: z.string(), text: z.string(), html: z.string() }),
) {}

export const EmailDeliverySchema = z
	.object({
		id: z.string(),
		template: z.string(),
		subject: z.string(),
		to_masked: z.string(),
		locale: LocaleRef,
		status: EmailStatusSchema,
		user: UserRefSchema.nullable(),
		attempts: z.number().int(),
		last_error: z.string().nullable(),
		created_at: DateTime,
		updated_at: DateTime,
	})
	.meta({ id: "EmailDelivery" })
export type EmailDelivery = z.infer<typeof EmailDeliverySchema>

export class EmailDeliveryPageDto extends zodDto(pageSchema(EmailDeliverySchema)) {}

export const DeliveryFilterSchema = z.object({
	status: EmailStatusSchema.optional(),
	template: z.string().max(64).optional(),
})

export class EmailDeliveryQueryDto extends zodDto(
	PageQuerySchema.extend(DeliveryFilterSchema.shape),
) {}

export class UserEmailQueryDto extends zodDto(PageQuerySchema) {}

export const EmailSuppressionSchema = z
	.object({
		/** Stable id of the suppressed address (a hash; the address itself is never stored). */
		id: z.string(),
		email_masked: z.string(),
		reason: z.enum(["bounce", "complaint", "manual"]),
		detail: z.string().nullable(),
		created_at: DateTime,
	})
	.meta({ id: "EmailSuppression" })
export type EmailSuppression = z.infer<typeof EmailSuppressionSchema>

export class EmailSuppressionPageDto extends zodDto(pageSchema(EmailSuppressionSchema)) {}

export class EmailSuppressionQueryDto extends zodDto(
	PageQuerySchema.extend({ reason: z.enum(["bounce", "complaint", "manual"]).optional() }),
) {}

export class SuppressionDeleteDto extends zodDto(ReasonSchema) {}

export class EmailTestRequestDto extends zodDto(
	z.object({
		template: z.string().max(64),
		locale: LocaleRef,
		/** Any address needs email.test.send.any; without it the caller's own address is used. */
		to: z.email().max(254).optional(),
	}),
) {}

export class EmailTestResultDto extends zodDto(
	z.object({ delivery_id: z.string(), to_masked: z.string() }),
) {}
