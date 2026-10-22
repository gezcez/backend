// response.ts
// Response envelope and pagination shapes (plan sections 3.2 and 7.0).

import { createZodDto } from "nestjs-zod"
import { z } from "zod"
import { ERROR_CODE_LIST, GezcezError, type ErrorCode, type ErrorDetails } from "./errors"

export interface ApiError {
	code: ErrorCode
	message: string
	details?: ErrorDetails
	request_id: string
}

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: ApiError }

export function ok<T>(data: T): { ok: true; data: T } {
	return { ok: true, data }
}

export function fail(error: ApiError): { ok: false; error: ApiError } {
	return { ok: false, error }
}

export const ErrorCodeSchema = z.enum(ERROR_CODE_LIST as [ErrorCode, ...ErrorCode[]])

export const ApiErrorSchema = z.object({
	code: ErrorCodeSchema,
	message: z.string(),
	details: z.record(z.string(), z.unknown()).optional(),
	request_id: z.string(),
})

export const ErrorResponseSchema = z.object({
	ok: z.literal(false),
	error: ApiErrorSchema,
})

export const PAGE_LIMIT_DEFAULT = 50
export const PAGE_LIMIT_MAX = 200
export const PAGE_TOTAL_CAP = 10_000

export const PageQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
	cursor: z.string().max(512).optional(),
	sort: z.string().max(200).optional(),
	q: z.string().max(200).optional(),
})
export type PageQuery = z.infer<typeof PageQuerySchema>

export interface Page<T> {
	items: T[]
	next_cursor: string | null
	prev_cursor: string | null
	total: number | null
}

export function pageSchema<T extends z.ZodType>(item: T) {
	return z.object({
		items: z.array(item),
		next_cursor: z.string().nullable(),
		prev_cursor: z.string().nullable(),
		total: z.number().int().nullable(),
	})
}

/**
 * createZodDto for schemas TypeScript cannot extend as a class (unions). The class is named so
 * the OpenAPI component gets a stable name.
 */
export function namedZodDto<T extends z.ZodType>(name: string, schema: T) {
	const dto = createZodDto(schema)
	Object.defineProperty(dto, "name", { value: name })
	return dto
}

export type SortDirection = "asc" | "desc"
export interface SortTerm<F extends string> {
	field: F
	dir: SortDirection
}

/**
 * Parses `sort` (comma list of `field:asc|desc`, direction optional and ascending by default)
 * against the endpoint's whitelist. Unknown fields and repeated fields are VALIDATION_FAILED.
 */
export function parseSort<F extends string>(
	sort: string | undefined,
	allowed: readonly F[],
	fallback: string,
): SortTerm<F>[] {
	const source = sort?.trim() ? sort : fallback
	const terms: SortTerm<F>[] = []
	for (const part of source.split(",")) {
		const [field = "", dir = "asc", ...rest] = part.trim().split(":")
		if (
			rest.length > 0 ||
			!(allowed as readonly string[]).includes(field) ||
			(dir !== "asc" && dir !== "desc") ||
			terms.some((term) => term.field === field)
		) {
			throw new GezcezError("VALIDATION_FAILED", `Cannot sort by "${part.trim()}"`, {
				fields: { sort: `allowed: ${allowed.join(", ")}` },
			})
		}
		terms.push({ field: field as F, dir })
	}
	return terms
}

/** `total` of the list contract: exact up to PAGE_TOTAL_CAP, else null. */
export function cappedTotal(count: number): number | null {
	return count > PAGE_TOTAL_CAP ? null : count
}
