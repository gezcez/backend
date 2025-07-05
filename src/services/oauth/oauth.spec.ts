import { describe, expect, test } from "bun:test"
import { bootstrap } from "../.."
import { agent } from "supertest"
describe("OAuthService", async () => {
	// const app = await bootstrap(true)
	const server = "http://localhost"
	test("can fail login", async () => {
		const resp1 = agent(server)
			.post("/oauth/login")
			.send({
				email: "jack.sparrow@gezcez.com",
				password: "sup!",
			})
			.expect(401)
			.then((data) => {
				expect(data.body.result?.success).toBe(false)
				expect(data.body.result?.message).toContain("Invalid")
			})
		const resp2 = agent(server)
			.post("/oauth/login")
			.send({
				email: "jack.sparrow@gezcez.com",
				password: "A0F!%6(.KV",
			})
			.expect(403)
			.then((data) => {
				expect(data.body.result?.success).toBe(false)
				expect(data.body.result?.message).toContain("karaliste")
				expect(data.body.ban_data).not.toBe(null)
			})
		await Promise.all([resp1,resp2])
	})
})
