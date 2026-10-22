// openapi.ts
// Builds the OpenAPI 3.1 document every client generates its types from (plan section 4.1).

import type { INestApplication } from "@nestjs/common"
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger"
import { cleanupOpenApiDoc } from "nestjs-zod"
import { z } from "zod"
import type { AppConfig } from "./config"
import { ApiErrorSchema, ErrorCodeSchema } from "./response"

type SchemaMap = NonNullable<NonNullable<OpenAPIObject["components"]>["schemas"]>

/** Hooks other modules use to add components or operation extensions before publishing. */
export type OpenApiDecorator = (document: OpenAPIObject) => void
const decorators: OpenApiDecorator[] = []
export function registerOpenApiDecorator(decorator: OpenApiDecorator): void {
	decorators.push(decorator)
}

function jsonSchema(schema: z.ZodType): SchemaMap[string] {
	const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
		target: "draft-2020-12",
	}) as Record<string, unknown>
	return rest as SchemaMap[string]
}

export function buildOpenApiDocument(app: INestApplication, config: AppConfig): OpenAPIObject {
	const builder = new DocumentBuilder()
		.setTitle("gezcez API")
		.setDescription(
			"OAuth authorization server, dashboard, mobile and public transit API for gezcez. " +
				"Every response except /v1/oauth/token, /v1/oauth/revoke, /.well-known/*, /health and " +
				"/ready is wrapped in `{ ok, data }` or `{ ok: false, error }`.",
		)
		.setVersion(config.version.packageVersion)
		.setOpenAPIVersion("3.1.0")
		.addServer(config.publicApiUrl)
		.addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT" }, "bearer")
		.addCookieAuth("__Host-gz_session", { type: "apiKey", in: "cookie" }, "session")
		.build()
	const raw = SwaggerModule.createDocument(app, builder, {
		operationIdFactory: (controller, method) =>
			`${controller.replace(/Controller$/, "")}_${method}`,
	})
	const document = cleanupOpenApiDoc(raw, { version: "3.1" })
	document.components ??= {}
	document.components.schemas = {
		...document.components.schemas,
		ErrorCode: jsonSchema(ErrorCodeSchema),
		ApiError: {
			...jsonSchema(ApiErrorSchema),
			properties: {
				...(jsonSchema(ApiErrorSchema) as { properties: Record<string, unknown> })
					.properties,
				code: { $ref: "#/components/schemas/ErrorCode" },
			},
		} as SchemaMap[string],
		ErrorResponse: {
			type: "object",
			required: ["ok", "error"],
			properties: {
				ok: { type: "boolean", enum: [false] },
				error: { $ref: "#/components/schemas/ApiError" },
			},
		},
	}
	for (const decorate of decorators) decorate(document)
	return sortKeys(document) as OpenAPIObject
}

/** Stable key order so the committed openapi.json diff is meaningful. */
function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys)
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, inner]) => [key, sortKeys(inner)]),
		)
	}
	return value
}
