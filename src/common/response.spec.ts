import { describe, expect, test } from "bun:test"
import { GezcezError } from "./errors"
import { cappedTotal, PAGE_TOTAL_CAP, parseSort } from "./response"
import { decodeCursor, encodeCursor, pageFrom } from "./utils/pagination.utils"

describe("parseSort", () => {
	const allowed = ["created_at", "display_name"] as const

	test("falls back to the default and parses comma lists", () => {
		expect(parseSort(undefined, allowed, "created_at:desc")).toEqual([
			{ field: "created_at", dir: "desc" },
		])
		expect(parseSort("display_name,created_at:desc", allowed, "created_at")).toEqual([
			{ field: "display_name", dir: "asc" },
			{ field: "created_at", dir: "desc" },
		])
	})

	test("refuses fields off the whitelist, bad directions and repeats", () => {
		for (const sort of ["email:asc", "created_at:up", "created_at,created_at:desc", "a:b:c"]) {
			expect(() => parseSort(sort, allowed, "created_at")).toThrow(GezcezError)
		}
	})
})

describe("cursors", () => {
	test("a cursor only works with the filters it was issued for", () => {
		const cursor = encodeCursor(50, { status: "active" })
		expect(decodeCursor(cursor, { status: "active" })).toBe(50)
		expect(() => decodeCursor(cursor, { status: "banned" })).toThrow(GezcezError)
		expect(() => decodeCursor("garbage", {})).toThrow(GezcezError)
	})

	test("pageFrom trims the probe row and links both directions", () => {
		const page = pageFrom([1, 2, 3], 2, 2, {}, 7)
		expect(page.items).toEqual([1, 2])
		expect(decodeCursor(page.next_cursor!, {})).toBe(4)
		expect(decodeCursor(page.prev_cursor!, {})).toBe(0)
		expect(pageFrom([1], 0, 2, {}, 1)).toMatchObject({ next_cursor: null, prev_cursor: null })
	})

	test("total is null above the cap", () => {
		expect(cappedTotal(PAGE_TOTAL_CAP)).toBe(PAGE_TOTAL_CAP)
		expect(cappedTotal(PAGE_TOTAL_CAP + 1)).toBeNull()
	})
})
