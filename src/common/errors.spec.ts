import { describe, expect, test } from "bun:test"
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common"
import { ThrottlerException } from "@nestjs/throttler"
import { ZodValidationException } from "nestjs-zod"
import { z } from "zod"
import { ERROR_CODES, ERROR_CODE_LIST, GezcezError } from "./errors"
import { normaliseError } from "./middlewares/exception.filter"

describe("error codes", () => {
	test("every code has an HTTP status and a message", () => {
		for (const code of ERROR_CODE_LIST) {
			expect(ERROR_CODES[code].status).toBeGreaterThanOrEqual(400)
			expect(ERROR_CODES[code].message.length).toBeGreaterThan(0)
		}
	})

	test("GezcezError carries the status of its code", () => {
		const error = new GezcezError("VERSION_CONFLICT")
		expect(error.status).toBe(412)
		expect(error.message).toBe(ERROR_CODES.VERSION_CONFLICT.message)
	})
})

describe("normaliseError", () => {
	test("GezcezError keeps code and details", () => {
		const result = normaliseError(
			new GezcezError("AUTH_STEP_UP_REQUIRED", undefined, { max_age: 600 }),
		)
		expect(result).toMatchObject({
			status: 403,
			code: "AUTH_STEP_UP_REQUIRED",
			details: { max_age: 600 },
		})
	})

	test("zod validation errors list the failing fields", () => {
		const parsed = z.object({ email: z.email() }).safeParse({ email: "nope" })
		const result = normaliseError(new ZodValidationException(parsed.error))
		expect(result.code).toBe("VALIDATION_FAILED")
		expect(result.status).toBe(400)
		expect((result.details?.fields as { path: string }[])[0]?.path).toBe("email")
	})

	test("Nest HTTP exceptions map to codes", () => {
		expect(normaliseError(new NotFoundException()).code).toBe("NOT_FOUND")
		expect(normaliseError(new ForbiddenException()).code).toBe("PERMISSION_MISSING")
		expect(normaliseError(new BadRequestException()).code).toBe("VALIDATION_FAILED")
		expect(normaliseError(new ThrottlerException()).code).toBe("RATE_LIMITED")
	})

	test("unknown errors become INTERNAL without leaking the message", () => {
		const result = normaliseError(new Error("database exploded at /secret/path"))
		expect(result).toEqual({
			status: 500,
			code: "INTERNAL",
			message: ERROR_CODES.INTERNAL.message,
		})
	})

	test("plain values thrown are INTERNAL too", () => {
		expect(normaliseError("boom").code).toBe("INTERNAL")
		expect(normaliseError(undefined).code).toBe("INTERNAL")
	})
})
