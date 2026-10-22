import { describe, expect, test } from "bun:test"
import { ConfigError, loadConfig } from "./config"

const SECRET = "x".repeat(32)

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
			NODE_ENV: "production",
			KEY_ENCRYPTION_SECRET: SECRET,
			SEAL_SECRET: SECRET,
			CODE_PEPPER: SECRET,
			CSRF_SECRET: SECRET,
			PUBLIC_API_URL: "https://api.gezcez.com/",
			CORS_ORIGINS: "https://oauth.gezcez.com, https://dash.gezcez.com",
		})
		expect(config.isProduction).toBe(true)
		expect(config.publicApiUrl).toBe("https://api.gezcez.com")
		expect(config.corsOrigins).toEqual(["https://oauth.gezcez.com", "https://dash.gezcez.com"])
	})

	test("STAGING_TEST_OTP is refused on the production API", () => {
		expect(() =>
			loadConfig({ PUBLIC_API_URL: "https://api.gezcez.com", STAGING_TEST_OTP: "123456" }),
		).toThrow(ConfigError)
		expect(
			loadConfig({
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
