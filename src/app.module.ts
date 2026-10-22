// app.module.ts
// Root module. Feature modules are added here as they land; MODE decides tracker modules later.

import { Module, type DynamicModule } from "@nestjs/common"
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core"
import { LoggerModule } from "nestjs-pino"
import { ZodSerializerInterceptor, ZodValidationPipe } from "nestjs-zod"
import { ConfigModule, type AppConfig } from "@common/config"
import { pinoHttpParams } from "@common/logger"
import { GezcezExceptionFilter, ResponseInterceptor } from "@common/middlewares"
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
				DatabaseModule,
				SystemModule,
				KeysModule,
				EmailModule,
				// Test-only routes are not even registered outside NODE_ENV=test.
				...(config.isTest ? [TestMailboxModule] : []),
			],
			providers: [
				{ provide: APP_FILTER, useClass: GezcezExceptionFilter },
				{ provide: APP_PIPE, useClass: ZodValidationPipe },
				// Order matters: the serializer strips the return value first, then the envelope wraps it.
				{ provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
				{ provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
			],
		}
	}
}
