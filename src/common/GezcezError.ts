import { Context } from "elysia"
import { GezcezResponse } from "./Gezcez"

export function GezcezError(error_type: ErrorType, error: any) {
	
	switch (error_type) {
		case "BAD_REQUEST": {
			return GezcezResponse({ __message: "Bad Request!", error_key: error_type, error: error }, 400)
		} case "INTERNAL_SERVER_ERROR": {
			return GezcezResponse({ __message: "Internal Server Error!", error_key: error_type, error: error }, 500)
		} case "NOT_AUTHENTICATED": {
			return GezcezResponse({ __message: "Not Authenticated!", error_key: error_type }, 401)
		} case "NOT_FOUND": {
			return GezcezResponse({ __message: "Not Found!", error_key: error_type }, 404)
		} case "UNAUTHORIZED": {
			return GezcezResponse({ __message: "Unauthorized!", error_key: error_type }, 401)
		} case "VALIDATION_FAILED" : {
			return GezcezResponse({ __message: "Object validation failed!", error_key: error_type, ...error }, 400)
		}
		default: {
			return GezcezResponse({ __message: "Unknown Error!", error_key: error_type }, 500)
		}
	}
}

export function GezcezValidationFailedError<T extends Context>(c:T,err:
	| `query:${(keyof T["query"] extends string ? keyof T["query"] : never)}`
	| `params:${(keyof T["params"] extends string ? keyof T["params"] : never)}`
	| `headers:${(keyof T["headers"] extends string ? keyof T["headers"] : never)}`
	| `body:${(keyof T["body"] extends string ? keyof T["body"] : never)}`
	| string & {},
	details?:string
) {
	return GezcezError("VALIDATION_FAILED",{error:`Object validation failed for '${err}'`,__message:details})
}

export type ErrorType =
	| "UNAUTHORIZED"
	| "NOT_AUTHENTICATED"
	| "BAD_REQUEST"
	| "INTERNAL_SERVER_ERROR"
	| "NOT_FOUND"
	| "VALIDATION_FAILED"