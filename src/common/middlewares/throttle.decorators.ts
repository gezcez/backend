// throttle.decorators.ts
// @RateLimit("preset") applies the IP rules of a preset before the handler runs. The global
// throttler guard applies the public-read limit to every route not marked @SkipThrottle().

import {
	applyDecorators,
	Injectable,
	SetMetadata,
	UseGuards,
	type CanActivate,
	type ExecutionContext,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { ThrottlerGuard, type ThrottlerLimitDetail } from "@nestjs/throttler"
import type { Request } from "express"
import { InjectConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"
import { RateLimitService, type RateLimitPreset } from "@common/rate-limits"
import { clientIp } from "@common/utils"

const RATE_LIMIT_KEY = "gezcez:rate-limit"

@Injectable()
export class RateLimitGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly limits: RateLimitService,
		@InjectConfig() private readonly config: AppConfig,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const presets =
			this.reflector.get<RateLimitPreset[]>(RATE_LIMIT_KEY, context.getHandler()) ?? []
		const req = context.switchToHttp().getRequest<Request>()
		const ip = clientIp(req, this.config.trustCfHeaders)
		for (const preset of presets) await this.limits.consume(preset, { ip }, { only: ["ip"] })
		return true
	}
}

/** Applies the IP rules of the given presets to a route. */
export function RateLimit(...presets: RateLimitPreset[]) {
	return applyDecorators(SetMetadata(RATE_LIMIT_KEY, presets), UseGuards(RateLimitGuard))
}

/** Global default limit (public-read); the tracker (trusted client IP) is set in app.module. */
@Injectable()
export class GezcezThrottlerGuard extends ThrottlerGuard {
	protected override async throwThrottlingException(
		_context: ExecutionContext,
		detail: ThrottlerLimitDetail,
	): Promise<void> {
		throw new GezcezError("RATE_LIMITED", undefined, {
			retry_after: Math.max(1, Math.ceil(detail.timeToBlockExpire)),
		})
	}
}
