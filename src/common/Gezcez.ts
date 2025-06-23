import Elysia, { Context, error, StatusMap } from "elysia"
import { GezcezError } from "./GezcezError"
import { ElysiaCustomStatusResponse, ElysiaErrors } from "elysia/dist/error"

export function GezcezResponse(data: {[key: string]:any, __message?: string }, {set}:Context, status?: number) {
	set.status = status || 200 // does not work since its outside of the elysiajs scope
	return {
		success: status===200,
		status: status || 200,
		time: Date.now(),
		formatted_time: new Date().toISOString(),
		message: data.__message || "OK",
		...data,
		__message:undefined,
	}
}
