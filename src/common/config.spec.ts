import { describe, expect, test } from "bun:test"
import { ConfigError, loadConfig } from "./config"

const SECRET = "x".repeat(32)
const PRODUCTION = {
	NODE_ENV: "production",
	KEY_ENCRYPTION_SECRET: SECRET,
	SEAL_SECRET: SECRET,
	CODE_PEPPER: SECRET,
	CSRF_SECRET: SECRET,
	TURNSTILE_SECRET: "turnstile-secret",
	EMAIL_TRANSPORT: "ses",
	SES_REGION: "eu-central-1",
}

function issuesOf(env: Record<string, string>): string {
	try {
		loadConfig(env)
	} catch (error) {
		if (error instanceof ConfigError) return error.issues.join("\n")
		throw error
	}
	return ""
}

describe("loadConfig", () => {
	test("defaults are usable for local development", () => {
		const config = loadConfig({})
		expect(config.env).toBe("development")
		expect(config.port).toBe(8080)
		expect(config.mode).toBe("all")
		expect(config.issuer).toBe("http://localhost:8080")
		expect(config.stepUpMaxAgeS).toBe(600)
		expect(config.refreshGraceS).toBe(10)
	})

	test("production refuses missing secrets and lists every problem", () => {
		try {
			loadConfig({ NODE_ENV: "production" })
			throw new Error("expected ConfigError")
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigError)
			const issues = (error as ConfigError).issues.join("\n")
			expect(issues).toContain("KEY_ENCRYPTION_SECRET")
			expect(issues).toContain("SEAL_SECRET")
			expect(issues).toContain("CODE_PEPPER")
			expect(issues).toContain("CSRF_SECRET")
		}
	})

	test("production accepts complete secrets", () => {
		const config = loadConfig({
			...PRODUCTION,
			PUBLIC_API_URL: "https://api.gezcez.com/",
			CORS_ORIGINS: "https://oauth.gezcez.com, https://dash.gezcez.com",
		})
		expect(config.isProduction).toBe(true)
		expect(config.publicApiUrl).toBe("https://api.gezcez.com")
		expect(config.corsOrigins).toEqual(["https://oauth.gezcez.com", "https://dash.gezcez.com"])
	})

	test("staging and production need Turnstile and the ses transport", () => {
		for (const NODE_ENV of ["production", "staging"]) {
			const issues = issuesOf({
				...PRODUCTION,
				NODE_ENV,
				TURNSTILE_SECRET: "",
				EMAIL_TRANSPORT: "",
			})
			expect(issues).toContain("TURNSTILE_SECRET")
			expect(issues).toContain("EMAIL_TRANSPORT")
			expect(issuesOf({ ...PRODUCTION, NODE_ENV, EMAIL_TRANSPORT: "console" })).toContain(
				"EMAIL_TRANSPORT",
			)
			expect(issuesOf({ ...PRODUCTION, NODE_ENV, SES_REGION: "" })).toContain("SES_REGION")
		}
	})

	test("development defaults only work on a loopback API URL", () => {
		for (const url of ["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"])
			expect(loadConfig({ PUBLIC_API_URL: url }).env).toBe("development")
		const issues = issuesOf({ PUBLIC_API_URL: "http://192.168.1.20:8080" })
		expect(issues).toContain("CODE_PEPPER")
		expect(issues).toContain("PUBLIC_API_URL is not loopback")
		const lan = loadConfig({
			PUBLIC_API_URL: "http://192.168.1.20:8080",
			KEY_ENCRYPTION_SECRET: SECRET,
			SEAL_SECRET: SECRET,
			CODE_PEPPER: SECRET,
			CSRF_SECRET: SECRET,
		})
		expect(lan.secrets.codePepper).toBe(SECRET)
	})

	test("STAGING_TEST_OTP is refused with NODE_ENV=production whatever the URL", () => {
		for (const url of [
			"https://api-staging.gezcez.com",
			"https://API.gezcez.com:443",
			"https://api.gezcez.com./",
		])
			expect(
				issuesOf({ ...PRODUCTION, PUBLIC_API_URL: url, STAGING_TEST_OTP: "123456" }),
			).toContain("STAGING_TEST_OTP")
	})

	test("STAGING_TEST_OTP is refused on the production API", () => {
		expect(
			issuesOf({
				NODE_ENV: "test",
				PUBLIC_API_URL: "https://api.gezcez.com",
				STAGING_TEST_OTP: "123456",
			}),
		).toContain("STAGING_TEST_OTP")
		expect(
			loadConfig({
				...PRODUCTION,
				NODE_ENV: "staging",
				PUBLIC_API_URL: "https://api-staging.gezcez.com",
				STAGING_TEST_OTP: "123456",
			}).stagingTestOtp,
		).toBe("123456")
	})

	test("the memory email transport only works in tests", () => {
		expect(() => loadConfig({ EMAIL_TRANSPORT: "memory" })).toThrow(ConfigError)
		expect(loadConfig({ NODE_ENV: "test", EMAIL_TRANSPORT: "memory" }).email.transport).toBe(
			"memory",
		)
	})

	test("the email transport defaults to memory in tests and console elsewhere", () => {
		expect(loadConfig({ NODE_ENV: "test" }).email.transport).toBe("memory")
		expect(loadConfig({}).email.transport).toBe("console")
	})

	test("short secrets are rejected", () => {
		expect(() => loadConfig({ SEAL_SECRET: "short" })).toThrow(ConfigError)
	})
})

test("empty variables count as unset", () => {
	const config = loadConfig({ PORT: "", BUILD_TIME: "", LOG_LEVEL: "" })
	expect(config.port).toBe(8080)
	expect(config.version.buildTime).toBeUndefined()
	expect(config.logLevel).toBe("info")
})
