// api-envelope.decorator.ts
// Documents a success response as `{ ok: true, data: <Dto> }` (or the bare DTO for raw routes),
// strips unknown keys from the return value with the DTO's zod schema, and points every error
// response at the shared ErrorResponse schema.

import { applyDecorators, HttpCode, type Type } from "@nestjs/common"
import { ApiDefaultResponse, ApiExtraModels, ApiResponse, getSchemaPath } from "@nestjs/swagger"
import { ZodSerializerDto, type ZodDto } from "nestjs-zod"

export interface ApiEnvelopeOptions {
	status?: number
	description?: string
	/** The route is @RawResponse(): document the DTO without the envelope. */
	raw?: boolean
}

type AnyZodDto = ZodDto & Type<unknown>

export function ApiEnvelope(dto: AnyZodDto | [AnyZodDto], options: ApiEnvelopeOptions = {}) {
	const isArray = Array.isArray(dto)
	const model = isArray ? dto[0] : dto
	const ref = { $ref: getSchemaPath(model) }
	const body = isArray ? { type: "array" as const, items: ref } : ref
	const status = options.status ?? 200
	const schema = options.raw
		? body
		: {
				type: "object" as const,
				required: ["ok", "data"],
				properties: { ok: { type: "boolean" as const, enum: [true] }, data: body },
			}
	return applyDecorators(
		ApiExtraModels(model),
		ApiResponse({ status, description: options.description ?? "Success", schema }),
		ApiDefaultResponse({
			description: "Error envelope",
			schema: { $ref: "#/components/schemas/ErrorResponse" },
		}),
		ZodSerializerDto(isArray ? [model] : model),
		...(options.status ? [HttpCode(options.status)] : []),
	)
}

/** For handlers that return nothing: documents `{ ok: true, data: null }` with the given status. */
export function ApiEmpty(status = 200, description = "Success") {
	return applyDecorators(
		ApiResponse({
			status,
			description,
			schema: {
				type: "object",
				required: ["ok", "data"],
				properties: { ok: { type: "boolean", enum: [true] }, data: { type: "null" } },
			},
		}),
		ApiDefaultResponse({
			description: "Error envelope",
			schema: { $ref: "#/components/schemas/ErrorResponse" },
		}),
		HttpCode(status),
	)
}
