// app.module.ts
// Root module. Feature modules are added here as they land; MODE decides tracker modules later.

import { Module, type DynamicModule } from "@nestjs/common"
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core"
import { ThrottlerModule } from "@nestjs/throttler"
import type { Request } from "express"
import { LoggerModule } from "nestjs-pino"
import { ZodSerializerInterceptor, ZodValidationPipe } from "nestjs-zod"
import { ConfigModule, type AppConfig } from "@common/config"
import { pinoHttpParams } from "@common/logger"
import {
	GezcezExceptionFilter,
	GezcezThrottlerGuard,
	ResponseInterceptor,
} from "@common/middlewares"
import { RATE_LIMIT_PRESETS, RateLimitModule } from "@common/rate-limits"
import { clientIp } from "@common/utils"
import { DatabaseModule } from "@db"
import { EmailModule } from "@services/email/email.module"
import { TestMailboxModule } from "@services/email/test-mailbox.controller"
import { KeysModule } from "@services/oauth/keys.module"
import { SystemModule } from "@services/system/system.module"

@Module({})
export class AppModule {
	static forRoot(config: AppConfig): DynamicModule {
		return {
			module: AppModule,
			imports: [
				ConfigModule.forRoot(config),
				LoggerModule.forRoot(pinoHttpParams(config)),
				ThrottlerModule.forRoot({
					throttlers: [
						{
							name: "default",
							ttl: RATE_LIMIT_PRESETS["public-read"][0].windowMs,
							limit: Math.floor(
								RATE_LIMIT_PRESETS["public-read"][0].limit * config.rateLimitScale,
							),
						},
					],
					getTracker: (req) => clientIp(req as unknown as Request, config.trustCfHeaders),
				}),
				RateLimitModule,
				DatabaseModule,
				SystemModule,
				KeysModule,
				EmailModule,
				// Test-only routes are not even registered outside NODE_ENV=test.
				...(config.isTest ? [TestMailboxModule] : []),
			],
			providers: [
				{ provide: APP_FILTER, useClass: GezcezExceptionFilter },
				{ provide: APP_GUARD, useClass: GezcezThrottlerGuard },
				{ provide: APP_PIPE, useClass: ZodValidationPipe },
				// Order matters: the serializer strips the return value first, then the envelope wraps it.
				{ provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
				{ provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
			],
		}
	}
}
