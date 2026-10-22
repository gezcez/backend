// response.interceptor.ts
// Wraps whatever a handler returns into `{ ok: true, data }`. Status codes come only from
// @HttpCode or the exception filter, so a plain return value can never turn into a 500
// (legacy bug 4).

import {
	Injectable,
	type CallHandler,
	type ExecutionContext,
	type NestInterceptor,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import type { Response } from "express"
import { map, type Observable } from "rxjs"
import { ok } from "@common/response"
import { RAW_RESPONSE_KEY } from "./raw-response.decorator"

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
	constructor(private readonly reflector: Reflector) {}

	intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
		if (context.getType() !== "http") return next.handle()
		const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
			context.getHandler(),
			context.getClass(),
		])
		if (raw) return next.handle()
		const res = context.switchToHttp().getResponse<Response>()
		return next.handle().pipe(
			map((data: unknown) => {
				if (res.headersSent) return data
				if (res.statusCode === 204) return undefined
				return ok(data === undefined ? null : data)
			}),
		)
	}
}
