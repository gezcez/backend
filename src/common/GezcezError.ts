import { Request } from "express"
import { GezcezResponse } from "./Gezcez"

export function GezcezError(error_type: ErrorType, error: any) {
	const err_message = error.__message
	error.__message = undefined
	switch (error_type) {
		case "NOT_IMPLEMENTED" : {
			return GezcezResponse(
				{
					__message: "Bu özellik daha kullanıma sunulmamış.",
					error_key: error_type,
					error: error,
				},
				501
			)
		}
		case "BAD_REQUEST": {
			return GezcezResponse(
				{
					__message: err_message || "Bad Request!",
					error_key: error_type,
					error: error,
				},
				400
			)
		}
		case "INTERNAL_SERVER_ERROR": {
			return GezcezResponse(
				{
					__message: err_message || "Internal Server Error!",
					error_key: error_type,
					error: error,
				},
				500
			)
		}
		case "FORBIDDEN": {
			return GezcezResponse(
				{ __message: err_message || "Forbidden!", error_key: error_type,error:error },
				403
			)
		}
		case "NOT_FOUND": {
			return GezcezResponse(
				{ __message: err_message || "Not Found!", error_key: error_type },
				404
			)
		}
		case "UNAUTHORIZED": {
			return GezcezResponse(
				{
					__message: err_message || "Unauthorized!",
					error_key: error_type,
					error:error,
				},
				401
			)
		}
		case "VALIDATION_FAILED": {
			return GezcezResponse(
				{
					__message: err_message || "Object validation failed!",
					error_key: error_type,
					error:error,
				},
				400
			)
		}
		case "RATELIMIT": {
			return GezcezResponse(
				{
					__message: err_message || "Object validation failed!",
					error_key: error_type,
					error:error,
				},
				429
			)
		}
		default: {
			return GezcezResponse(
				{ __message: err_message || "Unknown Error!", error_key: error_type },
				500
			)
		}
	}
}

export function GezcezValidationFailedError<T extends Request>(
	err:
		| `query:${string}`
		| `params:${keyof T["params"] extends string ? keyof T["params"] : never}`
		| `headers:${string}`
		| `body:${string}`
		| (string & {}),
	details?: string
) {
	return GezcezError("VALIDATION_FAILED", {
		error: `Object validation failed for '${err}'`,
		__message: details,
	})
}

export type ErrorType =
	| "UNAUTHORIZED"
	| "FORBIDDEN"
	| "BAD_REQUEST"
	| "INTERNAL_SERVER_ERROR"
	| "NOT_FOUND"
	| "VALIDATION_FAILED"
	| "RATELIMIT"
	| "NOT_IMPLEMENTED"