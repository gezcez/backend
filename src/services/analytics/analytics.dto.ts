// analytics.dto.ts
// Query parameters shared by every metric (plan 6.9, dashboard plan 6.6) and the columnar JSON
// response `{ columns, rows, meta }`.

import { createZodDto } from "nestjs-zod"
import { z } from "zod"
import { METRIC_KEYS } from "./analytics.queries"

/** Max window per request (days, inclusive). */
export const ANALYTICS_MAX_DAYS = 90

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
const hour = z.coerce.number().int().min(0).max(23)
/** External id or public id `<binding_id>.<external_id>` (the prefix is dropped). */
const externalRef = z
	.string()
	.trim()
	.regex(/^[\w.:-]{1,80}$/, "invalid id")
	.transform((value) => value.replace(/^\d+\./, ""))

export const AnalyticsQuerySchema = z.object({
	from: date.optional().describe("First local date (default: 6 days before `to`)"),
	to: date.optional().describe("Last local date, inclusive (default: today)"),
	date: date.optional().describe("One local day (sets from and to)"),
	route_id: z
		.string()
		.optional()
		.describe("Route id(s), comma separated: external or public `<binding>.<external>`")
		.transform((value, ctx) => {
			const parts = (value ?? "")
				.split(",")
				.map((part) => part.trim())
				.filter(Boolean)
			if (parts.length > 50) {
				ctx.addIssue({ code: "custom", message: "at most 50 routes" })
				return z.NEVER
			}
			const out: string[] = []
			for (const part of parts) {
				const parsed = externalRef.safeParse(part)
				if (!parsed.success) {
					ctx.addIssue({ code: "custom", message: `invalid route id: ${part}` })
					return z.NEVER
				}
				out.push(parsed.data)
			}
			return out
		}),
	direction: z.coerce.number().int().min(0).max(1).optional(),
	day_type: z.enum(["all", "weekday", "saturday", "sunday"]).default("all"),
	hour_from: hour.default(0),
	hour_to: hour.default(23),
	binding_id: z.coerce
		.number()
		.int()
		.positive()
		.optional()
		.describe("One binding of the network"),
	granularity: z.enum(["5m", "1h", "1d"]).default("1h").describe("fleet.hourly bucket size"),
	res: z.coerce.number().int().min(5).max(10).default(8).describe("speed.heatmap H3 resolution"),
	hour: hour.optional().describe("speed.heatmap: one local hour"),
	min_samples: z.coerce
		.number()
		.int()
		.min(1)
		.max(100_000)
		.default(30)
		.describe("speed.heatmap: minimum samples per cell"),
	min_stops: z.coerce
		.number()
		.int()
		.min(0)
		.max(1000)
		.default(5)
		.describe("runs.runtime: minimum max_stop_seq of a run"),
	stop_id: externalRef.optional().describe("dwell.stops: one stop, by hour"),
	limit: z.coerce.number().int().min(1).max(5000).default(100).describe("dwell.stops: top N"),
})
export class AnalyticsQueryDto extends createZodDto(AnalyticsQuerySchema) {}
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>

export class AnalyticsExportQueryDto extends createZodDto(
	AnalyticsQuerySchema.extend({ format: z.enum(["csv", "parquet"]).default("csv") }),
) {}

export const MetricKeySchema = z.enum(METRIC_KEYS)

const Cell = z.union([z.number(), z.string(), z.boolean(), z.null()])

export const MetricResultSchema = z.object({
	columns: z.array(z.string()),
	rows: z.array(z.array(Cell)),
	meta: z.object({
		metric: MetricKeySchema,
		n: z.number().int(),
		generated_at: z.string(),
		source: z.enum(["hot", "archive", "rollup"]),
		timezone: z.string(),
		from: z.string(),
		to: z.string(),
		binding_ids: z.array(z.number().int()),
	}),
})
export class MetricResultDto extends createZodDto(MetricResultSchema) {}
export type MetricResult = z.infer<typeof MetricResultSchema>

export const MetricInfoSchema = z.object({
	key: MetricKeySchema,
	description: z.string(),
	datasets: z.array(z.string()),
})
export const MetricCatalogSchema = z.object({
	metrics: z.array(MetricInfoSchema),
	max_days: z.number().int(),
	h3: z.enum(["extension", "js"]),
	archive: z.object({
		first_date: z.string().nullable(),
		last_date: z.string().nullable(),
	}),
})
export class MetricCatalogDto extends createZodDto(MetricCatalogSchema) {}
