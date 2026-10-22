// api-docs.decorators.ts
// Documentation-only decorators: the error codes an operation can answer with (grouped by HTTP
// status, one example envelope per code) and the shared path parameters. None of them changes
// how a request is handled.

import { applyDecorators } from "@nestjs/common"
import { ApiExtension, ApiParam, ApiResponse } from "@nestjs/swagger"
import { ERROR_CODES, type ErrorCode } from "@common/errors"

/** A request id as the API issues them (a ULID, or the cf-ray behind Cloudflare). */
export const EXAMPLE_REQUEST_ID = "01JBQ7Z4X8K2M5N9P3R6T1V0WY"

/** Example `details` per code, so the documented envelope matches what clients receive. */
const EXAMPLE_DETAILS: Partial<Record<ErrorCode, Record<string, unknown>>> = {
	VALIDATION_FAILED: {
		fields: [{ path: "limit", message: "Too big: expected number to be <=200", code: "too_big" }],
	},
	RATE_LIMITED: { retry_after: 42 },
	SCOPE_MISSING: { required: ["transit"] },
	VERSION_CONFLICT: { current_version: 8 },
	AUTH_STEP_UP_REQUIRED: { max_age: 600 },
}

/** Errors every bearer-token route can answer with before the handler runs. */
export const BEARER_ERRORS = [
	"AUTH_REQUIRED",
	"AUTH_TOKEN_INVALID",
	"AUTH_TOKEN_EXPIRED",
	"AUTH_SESSION_REVOKED",
] as const satisfies readonly ErrorCode[]

/**
 * Documents the error codes an operation can return: one response per HTTP status listing its
 * codes, with an example `{ ok: false, error }` envelope per code, plus `x-error-codes` on the
 * operation for tooling. Use once per handler; the `default` response from @ApiEnvelope still
 * covers anything unexpected (INTERNAL).
 */
export function ApiErrors(...codes: ErrorCode[]) {
	const unique = [...new Set(codes)]
	const byStatus = new Map<number, ErrorCode[]>()
	for (const code of unique) {
		const status = ERROR_CODES[code].status
		byStatus.set(status, [...(byStatus.get(status) ?? []), code])
	}
	const responses = [...byStatus.entries()]
		.sort(([a], [b]) => a - b)
		.map(([status, list]) =>
			ApiResponse({
				status,
				description: list
					.map((code) => `\`${code}\`: ${ERROR_CODES[code].message}`)
					.join("; "),
				schema: { $ref: "#/components/schemas/ErrorResponse" },
				examples: Object.fromEntries(
					list.map((code) => [
						code,
						{
							summary: ERROR_CODES[code].message,
							value: {
								ok: false,
								error: {
									code,
									message: ERROR_CODES[code].message,
									...(EXAMPLE_DETAILS[code]
										? { details: EXAMPLE_DETAILS[code] }
										: {}),
									request_id: EXAMPLE_REQUEST_ID,
								},
							},
						},
					]),
				),
			}),
		)
	return applyDecorators(...responses, ApiExtension("x-error-codes", unique))
}

/** `:networkId`: a network slug or its numeric id. */
export function ApiNetworkParam() {
	return ApiParam({
		name: "networkId",
		description: "Network slug or numeric id",
		example: "kocaeli-ulasimpark",
	})
}

/** `:routeId`: a stable public route id (`<binding>.<provider route id>`). */
export function ApiRouteParam() {
	return ApiParam({
		name: "routeId",
		description:
			"Stable public route id, `<binding>.<provider id>`; survives re-syncs, safe to store",
		example: "1.42041",
	})
}

/** `:stopId`: a stable public stop id (`<binding>.<provider stop id>`). */
export function ApiStopParam() {
	return ApiParam({
		name: "stopId",
		description:
			"Stable public stop id, `<binding>.<provider id>`; survives re-syncs, safe to store",
		example: "1.41003",
	})
}

/** `:vehicleId`: a stable public vehicle id (`<binding>.<provider vehicle id>`). */
export function ApiVehicleParam() {
	return ApiParam({
		name: "vehicleId",
		description: "Stable public vehicle id, `<binding>.<provider id>`",
		example: "1.4170",
	})
}

/** `:slug`: a city slug (the numeric id works too). */
export function ApiCityParam() {
	return ApiParam({ name: "slug", description: "City slug or numeric id", example: "kocaeli" })
}
