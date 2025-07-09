import {
	CallHandler,
	ExecutionContext,
	Injectable,
	Module,
	NestInterceptor,
	ValidationPipe,
} from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import { NestExpressApplication } from "@nestjs/platform-express"
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger"
import { apiReference } from "@scalar/nestjs-api-reference"
import { OAuthController } from "./services/oauth/oauth.controller"
import { BuildWSMessage, TerminalWsGateway } from "./ws/terminal.ws"

import {
	ArgumentsHost,
	Catch,
	ExceptionFilter,
	HttpException,
	HttpStatus,
} from "@nestjs/common"

import { WsAdapter } from "@nestjs/platform-ws"
import {
	buildConfig,
	GezcezError,
	IConfig,
	logger,
	LoggerMiddleware,
	resyncConfig,
	SYNCED_CONFIG,
} from "@shared"
import { Response } from "express"
import { map } from "rxjs"
import { db } from "./db"
import { SystemController } from "./services/system/system.controller"
import { WebController } from "./services/web/web.controller"
export let config : IConfig = {} as any




@Module({
	providers: [TerminalWsGateway],
	controllers: [OAuthController, SystemController, WebController],
})
class AppModule {}

export const SOCKETS: Set<WebSocket> = new Set()

const originalLog = console.log
console.log = (...args: any[]) => {
	originalLog(...args)
	SOCKETS.forEach((e) => {
		e.send(BuildWSMessage("message", [...args]))
	})
}

export async function bootstrap(ignore_listen?: boolean) {
	await resyncConfig({db:db})
	const imported_config = buildConfig<IConfig>()
	for (const key of Object.keys(imported_config)) {
		// change config without breaking reference
		config[key] = imported_config[key as keyof IConfig]
	}
	logger.success("Project init successfull, bootstrapping server")
	const app = await NestFactory.create<NestExpressApplication>(AppModule)
	app.useGlobalPipes(new ValidationPipe())
	app.useGlobalInterceptors(new ResponseInterceptor())
	app.use(LoggerMiddleware)
	app.useWebSocketAdapter(new WsAdapter(app))
	const openapi_doc = new DocumentBuilder()
		.setTitle("Gezcez.com Public API Documentation")
		.setDescription("Public API docs for Gezcez.com")
		.setVersion("1.0.0")
		.setContact("phasenull.dev", "https://phasenull.dev", "contact@phasenull.dev")
		.build()

	app.useGlobalFilters(new ErrorHandler())
	const document = SwaggerModule.createDocument(app, openapi_doc)
	app.use(
		"/docs",
		apiReference({
			theme: "bluePlanet",
			content: document,
		})
	)
	SwaggerModule.setup("swagger", app, document)
	if (!ignore_listen) {
		await app.listen(process.env.PORT || 80, process.env.HOST || "localhost")
		console.log(`Application is running on: ${await app.getUrl()}`)
	}
	return app
}

bootstrap()

@Catch()
class ErrorHandler implements ExceptionFilter {
	catch(exception: any, host: ArgumentsHost) {
		const ctx = host.switchToHttp()
		const response = ctx.getResponse()
		const request = ctx.getRequest()

		const status =
			exception instanceof HttpException
				? exception.getStatus()
				: HttpStatus.INTERNAL_SERVER_ERROR
		// console.error("Global Exception:", exception)
		if ((exception?.result?.status || status) === 500) {
			console.error(exception)
		}
		response.status(exception?.result?.status || status).json(
			exception?.result?.message
				? { ...exception, result: { ...exception.result, path: request.path } }
				: {
						result: {
							...getGezcezResponseFromStatus(exception?.result?.status || status),
							path: request.path,
						},
				  }
		)
	}
}

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
	intercept(context: ExecutionContext, next: CallHandler) {
		// You can also access the request/response if needed
		const ctx = context.switchToHttp()
		const response = ctx.getResponse() as Response
		// response.status(response.?.status || 500)

		return next.handle().pipe(
			map((data) => {
				// Example: Override status code if needed
				response.status(data.result?.status || 500)

				return data
			})
		)
	}
}

function getGezcezResponseFromStatus(status: number) {
	switch (status) {
		case 500: {
			return GezcezError("INTERNAL_SERVER_ERROR", {
				__message: "Sunucu hata verdi :(",
			})
		}
		case 404: {
			return GezcezError("NOT_FOUND", { __message: "Sayfa bulunamadı :(" })
		}
		case 400: {
			return GezcezError("BAD_REQUEST", {
				__message: "Sunucuya hatalı istek yolladın.",
			})
		}
		case 401: {
			return GezcezError("UNAUTHORIZED", {
				__message: "Bu işlemi gerçekleştirmek için giriş yapmalısın.",
			})
		}
		case 403: {
			return GezcezError("FORBIDDEN", {
				__message: "Bu işlemi gerçekleştirebilmek için yeterli iznin yok.",
			})
		}
		default: {
			return GezcezError("INTERNAL_SERVER_ERROR", {
				__message: `Sunucuda düşünemediğimiz gizemli bir hata oluştu (${status})`,
			})
		}
	}
}
