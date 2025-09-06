import {
	CallHandler,
	Controller,
	ExecutionContext,
	Get,
	Injectable,
	Logger,
	Module,
	NestInterceptor,
	Req,
	Res,
	StreamableFile,
	ValidationPipe
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
	HttpStatus
} from "@nestjs/common"
import { createReadStream } from "fs"
import { join } from "path"

import { WsAdapter } from "@nestjs/platform-ws"
import { type Request, type Response } from "express"
import { map } from "rxjs"
import { SystemController } from "./services/system/system.controller"
import { WebController } from "./services/web/web.controller"
import { SharedController } from "./services/shared/shared.controller"
import { DashboardController } from "./services/dashboard/dashboard.controller"
import { buildConfig, logger, RELOAD_SYNCED_CONFIG } from "@common/utils"
import { GezcezResponse, IConfig, LoggerMiddleware } from "@gezcez/core"
import { GezcezError } from "@gezcez/core"
import { DashboardModule } from "@services/dashboard/dahboard.module"

@Controller()
class IndexController {
	@Get("favicon.ico")
	async favicon(@Req() request: Request, @Res() response: Response) {
		if (!(request.headers["referer"]?.endsWith("/docs"))) {
			console.log("favicon request but not from /docs, returning 404")
			response.status(404).send(
				GezcezError("NOT_FOUND",{})
			)
			return 
			return GezcezError("NOT_FOUND",{__message:"default favicon is not set"})
		}
		const file = createReadStream(join(process.cwd(), "./src/assets/scalar-favicon.ico"))
		response.setHeader("Content-Type", "image/x-icon")
		response.setHeader("Cache-Control", "public, max-age=86400")
		file.on("end", () => {
			response.end()
		})
		file.pipe(response.status(200))
	}
}

export var config: IConfig = buildConfig()
@Module({
	providers: [TerminalWsGateway],
	imports: [DashboardModule],
	controllers: [
		IndexController,
		OAuthController,
		SystemController,
		WebController,
		SharedController
	]
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
	await RELOAD_SYNCED_CONFIG()

	Logger.log("Project init successfull, bootstrapping server", "bootstrap")
	const app = await NestFactory.create<NestExpressApplication>(AppModule, {
		cors: true
	})
	app.enableCors({
		origin: [
			"http://localhost:5173",
			"https://dash.gezcez.com",
			"http://localhost:8081",
			"https://oauth.gezcez.com"
		],
		credentials: true
	})
	app.useGlobalPipes(new ValidationPipe())
	app.useGlobalInterceptors(new ResponseInterceptor())
	app.use(LoggerMiddleware)
	app.useWebSocketAdapter(new WsAdapter(app))
	const openapi_doc = new DocumentBuilder()
		.setTitle("Gezcez.com Public API Documentation")
		.setDescription("Public API docs for Gezcez.com")
		.setVersion("1.0.0")
		.setContact(
			"phasenull.dev",
			"https://phasenull.dev",
			"contact@phasenull.dev"
		)
		.build()
	app.useGlobalFilters(new ErrorHandler())
	const document = SwaggerModule.createDocument(app, openapi_doc)
	app.use(
		"/docs",
		apiReference({
			theme: "bluePlanet",
			content: document,
			title: "Gezcez Public API Documentation",
		})
	)
	SwaggerModule.setup("swagger", app, document)
	if (!ignore_listen) {
		await app.listen(process.env.PORT || 80, process.env.HOST || "localhost")
		Logger.log(`Application is running on: ${await app.getUrl()}`, "bootstrap")
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
		// console.log(response.json())
		const status =
			exception.result?.status ||
			exception.status ||
			HttpStatus.INTERNAL_SERVER_ERROR
		if (![404, 400, 403, 401, 200].includes(status)) {
			console.error("global exception", status, exception.status, exception)
		}
		response.status(status).json(
			exception.result?.message
				? {
						...exception,
						result: { ...exception.result, path: request.path }
					}
				: {
						...getGezcezResponseFromStatus(exception?.result?.status || status),
						result: {
							...getGezcezResponseFromStatus(
								exception?.result?.status || status
							).result,
							message: exception.response?.message,
							path: request.path
						}
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
		const request = ctx.getRequest()

		return next.handle().pipe(
			map((data) => {
				// Example: Override status code if needed
				if ((response as any).headers["content-type"]?.startsWith("image/")) {
					response.status(200)
				} else {
					response.status(data?.result?.status || 500)

				}

				return data
			})
		)
	}
}

function getGezcezResponseFromStatus(status: number) {
	switch (status) {
		case 500: {
			return GezcezError("INTERNAL_SERVER_ERROR", {
				__message: "Sunucu hata verdi :("
			})
		}
		case 404: {
			return GezcezError("NOT_FOUND", { __message: "Sayfa bulunamadı :(" })
		}
		case 400: {
			return GezcezError("BAD_REQUEST", {
				__message: "Sunucuya hatalı istek yolladın."
			})
		}
		case 401: {
			return GezcezError("UNAUTHORIZED", {
				__message: "Bu işlemi gerçekleştirmek için giriş yapmalısın."
			})
		}
		case 403: {
			return GezcezError("FORBIDDEN", {
				__message: "Bu işlemi gerçekleştirebilmek için yeterli iznin yok."
			})
		}
		default: {
			return GezcezError("INTERNAL_SERVER_ERROR", {
				__message: `Sunucuda düşünemediğimiz gizemli bir hata oluştu (${status})`
			})
		}
	}
}
