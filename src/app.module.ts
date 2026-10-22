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
	AuthenticationGuard,
	GezcezExceptionFilter,
	GezcezThrottlerGuard,
	ResponseInterceptor,
} from "@common/middlewares"
import { RATE_LIMIT_PRESETS, RateLimitModule } from "@common/rate-limits"
import { clientIp } from "@common/utils"
import { DatabaseModule } from "@db"
import { AccountModule } from "@services/account/account.module"
import { AuditModule } from "@services/audit/audit.module"
import { EmailModule } from "@services/email/email.module"
import { TestMailboxModule } from "@services/email/test-mailbox.controller"
import { KeysModule } from "@services/oauth/keys.module"
import { OAuthModule } from "@services/oauth/oauth.module"
import { RolesModule } from "@services/roles/roles.module"
import { SystemModule } from "@services/system/system.module"
import { UsersModule } from "@services/users/users.module"

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
				AuditModule,
				AccountModule,
				OAuthModule,
				RolesModule,
				UsersModule,
				// Test-only routes are not even registered outside NODE_ENV=test.
				...(config.isTest ? [TestMailboxModule] : []),
			],
			providers: [
				{ provide: APP_FILTER, useClass: GezcezExceptionFilter },
				// Guards run in this order: the default IP limit, then the bearer token check.
				{ provide: APP_GUARD, useClass: GezcezThrottlerGuard },
				{ provide: APP_GUARD, useClass: AuthenticationGuard },
				{ provide: APP_PIPE, useClass: ZodValidationPipe },
				// Order matters: the serializer strips the return value first, then the envelope wraps it.
				{ provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
				{ provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
			],
		}
	}
}
