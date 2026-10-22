import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { nullableProperty } from "./openapi"

describe("nullableProperty", () => {
	test("rewrites a type list with null to anyOf, keeping constraints inside", () => {
		expect(
			nullableProperty({
				type: ["string", "null"],
				format: "date-time",
				description: "When",
				required: true,
			}),
		).toEqual({
			type: "",
			description: "When",
			required: true,
			"x-nestjs_zod-empty-type": true,
			anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
		})
	})

	test("leaves other properties alone", () => {
		const meta = { type: "string", required: true }
		expect(nullableProperty(meta)).toBe(meta)
	})
})

describe("committed openapi.json", () => {
	const doc = JSON.parse(readFileSync(`${import.meta.dir}/../../openapi.json`, "utf8")) as {
		components: { schemas: Record<string, { properties?: Record<string, unknown> }> }
	}
	const schemas = doc.components.schemas

	test("top-level nullable DTO fields are not published as arrays", () => {
		expect(schemas.VehicleSnapshotDto!.properties!.message).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }],
		})
		expect(schemas.StopDetailDto!.properties!.code).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }],
		})
		const wrapped = Object.entries(schemas).flatMap(([name, schema]) =>
			Object.entries(schema.properties ?? {})
				.filter(([, p]) => {
					const prop = p as { type?: string; items?: { anyOf?: { type?: string }[] } }
					return (
						prop.type === "array" && prop.items?.anyOf?.some((v) => v.type === "null")
					)
				})
				.map(([key]) => `${name}.${key}`),
		)
		expect(wrapped).toEqual([])
	})

	test("the WS protocol is published", () => {
		expect(schemas).toHaveProperty("WsClientMessage")
		expect(schemas).toHaveProperty("WsServerMessage")
	})
})
