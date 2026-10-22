// exception.filter.ts
// Maps every error to `{ ok: false, error: { code, message, details?, request_id } }` with the
// status from the error code table. Unknown errors become INTERNAL and are logged with the stack.

import {
	Catch,
	HttpException,
	HttpStatus,
	Logger,
	type ArgumentsHost,
	type ExceptionFilter,
} from "@nestjs/common"
import { ThrottlerException } from "@nestjs/throttler"
import type { Request, Response } from "express"
import { ZodValidationException } from "nestjs-zod"
import { ERROR_CODES, GezcezError, OAuthProtocolError, type ErrorCode } from "@common/errors"
import { fail } from "@common/response"

interface ZodLikeIssue {
	path: PropertyKey[]
	message: string
	code: string
}

function zodFields(error: unknown): { path: string; message: string; code: string }[] {
	const issues = (error as { issues?: ZodLikeIssue[] } | undefined)?.issues ?? []
	return issues.map((issue) => ({
		path: issue.path.map(String).join("."),
		message: issue.message,
		code: issue.code,
	}))
}

function codeForStatus(status: number): ErrorCode {
	switch (status) {
		case HttpStatus.BAD_REQUEST:
		case HttpStatus.PAYLOAD_TOO_LARGE:
		case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
		case HttpStatus.UNPROCESSABLE_ENTITY:
			return "VALIDATION_FAILED"
		case HttpStatus.UNAUTHORIZED:
			return "AUTH_REQUIRED"
		case HttpStatus.FORBIDDEN:
			return "PERMISSION_MISSING"
		case HttpStatus.NOT_FOUND:
		case HttpStatus.METHOD_NOT_ALLOWED:
			return "NOT_FOUND"
		case HttpStatus.CONFLICT:
			return "CONFLICT"
		case HttpStatus.PRECONDITION_FAILED:
			return "VERSION_CONFLICT"
		case HttpStatus.TOO_MANY_REQUESTS:
			return "RATE_LIMITED"
		default:
			return "INTERNAL"
	}
}

export interface NormalisedError {
	status: number
	code: ErrorCode
	message: string
	details?: Record<string, unknown>
}

/** Converts anything thrown into a status, code, message and details. Exported for tests. */
export function normaliseError(exception: unknown, res?: Response): NormalisedError {
	if (exception instanceof GezcezError) {
		return {
			status: exception.status,
			code: exception.code,
			message: exception.message,
			details: exception.details,
		}
	}
	if (exception instanceof ZodValidationException) {
		return {
			status: 400,
			code: "VALIDATION_FAILED",
			message: ERROR_CODES.VALIDATION_FAILED.message,
			details: { fields: zodFields(exception.getZodError()) },
		}
	}
	if (exception instanceof ThrottlerException) {
		const header = res?.getHeader("Retry-After")
		const retryAfter = Number(Array.isArray(header) ? header[0] : header)
		return {
			status: 429,
			code: "RATE_LIMITED",
			message: ERROR_CODES.RATE_LIMITED.message,
			details: Number.isFinite(retryAfter) ? { retry_after: retryAfter } : undefined,
		}
	}
	if (exception instanceof HttpException) {
		const status = exception.getStatus()
		const code = codeForStatus(status)
		const message = code === "INTERNAL" ? ERROR_CODES.INTERNAL.message : exception.message
		return { status: code === "INTERNAL" ? 500 : status, code, message }
	}
	// body-parser and other express errors carry a numeric status and an expose flag.
	const maybe = exception as { status?: unknown; expose?: unknown; message?: unknown } | null
	if (
		maybe &&
		typeof maybe.status === "number" &&
		maybe.status >= 400 &&
		maybe.status < 500 &&
		maybe.expose === true
	) {
		return {
			status: maybe.status,
			code: codeForStatus(maybe.status),
			message: typeof maybe.message === "string" ? maybe.message : "Bad request",
		}
	}
	return { status: 500, code: "INTERNAL", message: ERROR_CODES.INTERNAL.message }
}

@Catch()
export class GezcezExceptionFilter implements ExceptionFilter {
	private readonly logger = new Logger("ExceptionFilter")

	catch(exception: unknown, host: ArgumentsHost): void {
		if (host.getType() !== "http") throw exception
		const ctx = host.switchToHttp()
		const req = ctx.getRequest<Request & { id?: string }>()
		const res = ctx.getResponse<Response>()
		if (res.headersSent) return

		if (exception instanceof OAuthProtocolError) {
			res.status(exception.status)
				.setHeader("Cache-Control", "no-store")
				.json({ error: exception.error, error_description: exception.description })
			return
		}

		const error = normaliseError(exception, res)
		if (error.code === "INTERNAL") {
			this.logger.error(
				{ err: exception, request_id: req.id },
				exception instanceof Error ? exception.message : "Unhandled error",
			)
		}
		res.status(error.status).json(
			fail({
				code: error.code,
				message: error.message,
				...(error.details ? { details: error.details } : {}),
				request_id: req.id ?? "",
			}),
		)
	}
}
