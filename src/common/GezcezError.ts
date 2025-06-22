import { Context } from "elysia"
import { GezcezResponse } from "./Gezcez"

export function GezcezError(error_type: ErrorType, error:any,ctx:Context) {
	switch (error_type) {
		case "BAD_REQUEST": {
			return GezcezResponse({ __message: "Bad Request!", error_key: error_type,error:error },ctx, 400)
		} case "INTERNAL_SERVER_ERROR": {
			return GezcezResponse({ __message: "Internal Server Error!", error_key: error_type,error:error },ctx, 500)
		} case "NOT_AUTHENTICATED": {
			return GezcezResponse({ __message: "Not Authenticated!", error_key: error_type },ctx, 401)
		} case "NOT_FOUND": {
			return GezcezResponse({ __message: "Not Found!", error_key: error_type },ctx,404)
		} case "UNAUTHORIZED": {
			return GezcezResponse({ __message: "Unauthorized!", error_key: error_type },ctx,401)
		}
		default: {
			return GezcezResponse({ __message: "Unknown Error!", error_key: error_type },ctx,500)
		}
	}
}


export type ErrorType =
	| "UNAUTHORIZED"
	| "NOT_AUTHENTICATED"
	| "BAD_REQUEST"
	| "INTERNAL_SERVER_ERROR"
	| "NOT_FOUND"