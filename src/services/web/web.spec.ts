import { describe, expect, test } from "bun:test"
import { bootstrap } from "../.."
import { agent } from "supertest"
describe("WebService", async () => {
	// const app = await bootstrap(true)
	const server = "http://localhost"
	test("can list providers", async () => {
		const resp = await agent(server)
			.get("/web/providers/list")
			.expect(200)
		expect(resp.body.result?.success).toBe(true)
		expect(resp.body.providers).toBeArray()
		expect(resp.body.providers.length).toBeGreaterThan(0)
	})

	test("can optout card", async () => {
		// todo
		const resp = await agent(server)
			.post("/web/privacy/1/opt-out")
			.send({
				"card_no": "0",
				"features": [
				  "card_images"
				]
			 })
			.expect(501)
		expect(resp.body.result?.success).toBe(false)
		// expect(resp.body.result?.message).toContain("karaliste")
		// expect(resp.body.ban_data).not.toBe(null)
	})

	test("optout form is not null", async ()=>{
		
		const resp = await agent(server)
			.get("/web/privacy/get-form")
			.expect(200)
		expect(resp.body.result?.success).toBe(true)
		expect(resp.body.networks).toBeArray()
		expect(resp.body.networks.length).toBeGreaterThan(0)
		const network = resp.body.networks.at(0)
		expect(network?.network).not.toBe(null)
		expect(network?.provider).not.toBe(null)
		expect(network?.provider?.pulled_data).toBeArray()
	})

	test("can list networks", async ()=>{
		
		const resp = await agent(server)
			.get("/web/networks/list")
			.expect(200)
		expect(resp.body.result?.success).toBe(true)
		expect(resp.body.networks).toBeArray()
		expect(resp.body.networks.length).toBeGreaterThan(0)
		const network = resp.body.networks.at(0)
		expect(network?.network).not.toBe(null)
		expect(network?.network.created_by).toBe(undefined)
		expect(network?.provider).not.toBe(null)
	})
})
