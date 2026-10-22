import { describe, expect, test } from "bun:test"
import { compareVersions } from "./app-config.service"

describe("compareVersions", () => {
	test("orders dotted versions numerically", () => {
		expect(compareVersions("1.10.0", "1.9.9")).toBe(1)
		expect(compareVersions("1.2", "1.2.0")).toBe(0)
		expect(compareVersions("0.9.0", "1.0.0")).toBe(-1)
		expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(0)
	})
})
