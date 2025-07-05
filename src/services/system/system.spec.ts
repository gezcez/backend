import { describe, expect, test } from "bun:test"
import { bootstrap } from "../.."
import { agent } from "supertest"
describe("SystemService", async () => {
	// const app = await bootstrap(true)
	const server = "http://localhost"
	test("authorizations fails", async () => {
		await agent(server)
			.get("/system/networks")
			.expect(401)
			.then((data) => {
				expect(data.body.result?.success).toBe(false)
			})
		await agent(server)
			.get("/system/permissions/list")
			.expect(401)
			.then((data) => {
				expect(data.body.result?.success).toBe(false)
			})
		await agent(server)
			.get("/system/1/sudo-test")
			.expect(401)
			.then((data) => {
				expect(data.body.result?.success).toBe(false)
			})
		await agent(server)
			.get("/system/sudo-test")
			.expect(401)
			.then((data) => {
				expect(data.body.result?.success).toBe(false)
			})
	})
})
