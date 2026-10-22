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

const PATCHED = Symbol("gezcez:nullable-patched")
type MetadataFactory = () => Record<string, Record<string, unknown>>
type DtoClass = { _OPENAPI_METADATA_FACTORY?: MetadataFactory; [PATCHED]?: true }

/**
 * nestjs-zod describes a top-level nullable property as `type: ["string", "null"]`, which
 * @nestjs/swagger reads as an array of strings. Rewrites those properties to the
 * `anyOf: [{type}, {type: "null"}]` form nestjs-zod already uses for other nullable values.
 */
export function nullableProperty(meta: Record<string, unknown>): Record<string, unknown> {
	const type = meta.type
	if (!Array.isArray(type) || !type.includes("null")) return meta
	const rest = type.filter((t) => t !== "null") as string[]
	const outer: Record<string, unknown> = { type: "" }
	const inner: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(meta)) {
		if (key === "type") continue
		if (key === "description" || key === "required" || key.startsWith("x-")) outer[key] = value
		else inner[key] = value
	}
	outer["x-nestjs_zod-empty-type"] = true
	const variants = rest.map((t, i) => (i === 0 ? { ...inner, type: t } : { type: t }))
	outer.anyOf = [...variants, { type: "null" }]
	return outer
}

/**
 * Swagger reads the factory of every class in the prototype chain (the DTO and the base class
 * createZodDto made), so each one that defines its own factory is wrapped.
 */
function patchDto(dto: unknown): void {
	for (let cls = dto; typeof cls === "function" && cls !== Function.prototype;) {
		const target = cls as DtoClass
		const factory = Object.getOwnPropertyDescriptor(target, "_OPENAPI_METADATA_FACTORY")
			?.value as MetadataFactory | undefined
		if (factory && !Object.prototype.hasOwnProperty.call(target, PATCHED)) {
			target[PATCHED] = true
			target._OPENAPI_METADATA_FACTORY = () =>
				Object.fromEntries(
					Object.entries(factory.call(target)).map(([key, meta]) => [
						key,
						nullableProperty(meta),
					]),
				)
		}
		cls = Object.getPrototypeOf(cls) as unknown
	}
}

/** Every DTO class a controller method names (responses, extra models, parameters). */
function patchControllerDtos(app: INestApplication): void {
	const container = (app as unknown as { container: { getModules(): Map<string, Module> } })
		.container
	type Module = { controllers: Map<unknown, { metatype?: { prototype: object } | null }> }
	for (const module of container.getModules().values()) {
		for (const wrapper of module.controllers.values()) {
			const proto = wrapper.metatype?.prototype
			if (!proto) continue
			for (const name of Object.getOwnPropertyNames(proto)) {
				if (name === "constructor") continue
				const handler = (proto as Record<string, unknown>)[name]
				const models = [
					...((Reflect.getMetadata(
						"swagger/apiExtraModels",
						handler as object,
					) as unknown[]) ?? []),
					...((Reflect.getMetadata("design:paramtypes", proto, name) as unknown[]) ?? []),
				]
				for (const model of models) patchDto(model)
			}
		}
	}
}

export function buildOpenApiDocument(app: INestApplication, config: AppConfig): OpenAPIObject {
	patchControllerDtos(app)
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
