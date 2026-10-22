import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createTestApp, type TestApp } from "../helpers/app"

let t: TestApp

beforeAll(async () => {
	t = await createTestApp()
})
afterAll(async () => {
	await t.close()
})

describe("system", () => {
	test("GET /health is raw and unprefixed", async () => {
		const res = await t.json("/health")
		expect(res.status).toBe(200)
		expect(res.body).toEqual({ status: "ok" })
		expect(res.headers.get("x-request-id")).toBeTruthy()
	})

	test("GET /ready reports the core database", async () => {
		const res = await t.json<{ ready: boolean; checks: { name: string; ok: boolean }[] }>(
			"/ready",
		)
		expect(res.status).toBe(200)
		expect(res.body.ready).toBe(true)
		expect(res.body.checks).toContainEqual({ name: "db.core", ok: true })
	})

	test("GET /v1/system/version is wrapped in the envelope", async () => {
		const res = await t.json<{ ok: boolean; data: { mode: string; env: string } }>(
			"/v1/system/version",
		)
		expect(res.status).toBe(200)
		expect(res.body.ok).toBe(true)
		expect(res.body.data.mode).toBe("all")
		expect(res.body.data.env).toBe("test")
	})

	test("unknown routes return the error envelope with the request id", async () => {
		const res = await t.json<{ ok: boolean; error: { code: string; request_id: string } }>(
			"/v1/does-not-exist",
		)
		expect(res.status).toBe(404)
		expect(res.body.ok).toBe(false)
		expect(res.body.error.code).toBe("NOT_FOUND")
		expect(res.body.error.request_id).toBe(res.headers.get("x-request-id")!)
	})

	test("malformed JSON is a validation error, not a 500", async () => {
		const res = await t.json<{ error: { code: string } }>("/v1/system/version", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		})
		expect(res.status).toBe(400)
		expect(res.body.error.code).toBe("VALIDATION_FAILED")
	})

	test("the API is not mounted without the /v1 prefix", async () => {
		const res = await t.fetch("/system/version")
		expect(res.status).toBe(404)
	})

	test("GET /openapi.json publishes the error code enum", async () => {
		const res = await t.json<{
			openapi: string
			paths: Record<string, unknown>
			components: { schemas: Record<string, { enum?: string[] }> }
		}>("/openapi.json")
		expect(res.status).toBe(200)
		expect(res.body.openapi).toStartWith("3.1")
		expect(res.body.paths["/v1/system/version"]).toBeDefined()
		expect(res.body.paths["/health"]).toBeDefined()
		expect(res.body.components.schemas.ErrorCode?.enum).toContain("AUTH_STEP_UP_REQUIRED")
		expect(res.body.components.schemas.ErrorResponse).toBeDefined()
	})

	test("GET /docs serves the Scalar reference", async () => {
		const res = await t.fetch("/docs")
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("text/html")
		expect(await res.text()).toContain("/openapi.json")
	})
})
