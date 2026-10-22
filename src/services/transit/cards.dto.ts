// cards.dto.ts
// Card balance and history by card number (plan 6.11, capability `card`). POST so the number
// stays out of URLs and access logs.

import { createZodDto } from "nestjs-zod"
import { z } from "zod"

const CardNumber = z
	.string()
	.trim()
	.transform((v) => v.replace(/[\s-]/g, ""))
	.pipe(z.string().regex(/^[0-9A-Za-z]{6,32}$/, "card_number is 6 to 32 letters or digits"))

export const CardLookupBodySchema = z.object({ card_number: CardNumber })
export class CardLookupBodyDto extends createZodDto(CardLookupBodySchema) {}

export const CardHistoryBodySchema = z.object({
	card_number: CardNumber,
	month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month is YYYY-MM"),
})
export class CardHistoryBodyDto extends createZodDto(CardHistoryBodySchema) {}

export const CardLookupSchema = z.object({
	balance: z.number(),
	currency: z.string(),
	as_of: z.iso.datetime(),
	card_type: z.string().nullable(),
})
export class CardLookupDto extends createZodDto(CardLookupSchema) {}

export const CardHistorySchema = z.object({
	month: z.string(),
	currency: z.string(),
	items: z.array(
		z.object({
			at: z.iso.datetime(),
			kind: z.enum(["boarding", "topup", "transfer", "other"]),
			amount: z.number(),
			balance_after: z.number().nullable(),
			route_short_name: z.string().nullable(),
		}),
	),
})
export class CardHistoryDto extends createZodDto(CardHistorySchema) {}
