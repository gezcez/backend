import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { crc32, createZip, readZip } from "./zip.utils"

describe("zip", () => {
	test("crc32 matches the reference value", () => {
		expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926)
		expect(crc32(new Uint8Array())).toBe(0)
	})

	test("round-trips stored and deflated entries with UTF-8 names", () => {
		const modified = new Date(Date.UTC(2026, 9, 22, 13, 45, 10))
		const big = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ i })) })
		const zip = createZip([
			{ name: "README.txt", data: "Merhaba, verileriniz burada. Ğüşiöç", modified },
			{ name: "data/profile.json", data: big, modified },
			{ name: "x", data: new Uint8Array([1]), modified },
			{ name: "boş.json", data: "", modified },
		])
		const entries = readZip(zip)
		expect(entries.map((e) => e.name)).toEqual([
			"README.txt",
			"data/profile.json",
			"x",
			"boş.json",
		])
		expect(entries[0]!.data.toString("utf8")).toBe("Merhaba, verileriniz burada. Ğüşiöç")
		expect(entries[1]!.data.toString("utf8")).toBe(big)
		expect([...entries[2]!.data]).toEqual([1])
		expect(entries[3]!.data.length).toBe(0)
		expect(entries[0]!.modified.toISOString()).toBe("2026-10-22T13:45:10.000Z")
		// Deflate actually shrank the repetitive JSON.
		expect(zip.length).toBeLessThan(big.length)
	})

	test("rejects unsafe or duplicate names", () => {
		expect(() => createZip([{ name: "../etc/passwd", data: "" }])).toThrow()
		expect(() => createZip([{ name: "/abs", data: "" }])).toThrow()
		expect(() =>
			createZip([
				{ name: "a", data: "" },
				{ name: "a", data: "" },
			]),
		).toThrow()
	})

	test("detects corruption", () => {
		const zip = createZip([{ name: "a.txt", data: "hello hello hello hello hello" }])
		const broken = Buffer.from(zip)
		broken[40] = broken[40]! ^ 0xff
		expect(() => readZip(broken)).toThrow()
		expect(() => readZip(Buffer.from("not a zip at all, definitely not"))).toThrow()
	})

	test("the system unzip accepts the archive", () => {
		const unzip = Bun.which("unzip")
		if (!unzip) return
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-spec-"))
		try {
			const file = path.join(dir, "a.zip")
			fs.writeFileSync(
				file,
				createZip([
					{ name: "README.txt", data: "hello\n".repeat(100) },
					{ name: "profile.json", data: '{"a":1}' },
				]),
			)
			const result = Bun.spawnSync([unzip, "-t", file])
			expect(result.exitCode).toBe(0)
			expect(result.stdout.toString()).toContain("No errors detected")
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})
})
