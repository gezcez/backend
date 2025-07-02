import { NestFactory } from "@nestjs/core"
import { LoggerMiddleware } from "./middlewares/logger.middleware"
import { NestExpressApplication } from "@nestjs/platform-express"
import { Module, ValidationPipe, WebSocketAdapter } from "@nestjs/common"
import { BuildWSMessage, TerminalWsGateway } from "./ws/terminal.ws"
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger"
import { OAuthController } from "./services/oauth/oauth.controller"
import { apiReference } from "@scalar/nestjs-api-reference"

import { WsAdapter } from "@nestjs/platform-ws"
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

async function bootstrap() {
	const app = await NestFactory.create<NestExpressApplication>(AppModule)

	app.useGlobalPipes(new ValidationPipe())
	app.use(LoggerMiddleware)
	app.useWebSocketAdapter(new WsAdapter(app))
	const config = new DocumentBuilder()
		.setTitle("Gezcez.com Public API Documentation")
		.setDescription("Public API docs for Gezcez.com")
		.setVersion("1.0.0")
		.setContact("phasenull.dev", "https://phasenull.dev", "contact@phasenull.dev")
		.build()

	app.useGlobalFilters(new ErrorHandler())
	const document = SwaggerModule.createDocument(app, config)
	app.use(
		"/docs",
		apiReference({
			theme: "bluePlanet",
			content: document,
		})
	)
	SwaggerModule.setup("swagger", app, document)

	await app.listen(process.env.PORT || 80, process.env.HOST || "localhost")
	console.log(`Application is running on: ${await app.getUrl()}`)
}
bootstrap()

import {
	ExceptionFilter,
	Catch,
	ArgumentsHost,
	HttpException,
	HttpStatus,
} from "@nestjs/common"
import { GezcezError } from "./common/GezcezError"
import { GezcezResponse } from "./common/Gezcez"
import { SystemController } from "./services/system/system.controller"
import { WebController } from "./services/web/web.controller"

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
		if ((exception.result.status || status) === 500) {
			console.error(exception)
		}
		response.status(exception.result.status || status).json(
			exception.result.message
				? { ...exception, result: { ...exception.result, path: request.path } }
				: {
						result: {
							...getGezcezResponseFromStatus(exception.result.status || status),
							path: request.path,
						},
				  }
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
