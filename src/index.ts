import { NestFactory } from "@nestjs/core"
import { LoggerMiddleware } from "./middlewares/logger.middleware"
import { NestExpressApplication } from "@nestjs/platform-express"
import { Module, ValidationPipe, WebSocketAdapter } from "@nestjs/common"
import { WsGateway } from "./ws/ws.gateway"
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger"
import { OAuthController } from "./services/oauth/oauth.controller"
import { apiReference } from "@scalar/nestjs-api-reference"

@Module({
	providers: [WsGateway],
	controllers: [OAuthController],
})
class AppModule {}

export const SOCKETS: Map<string, undefined> = new Map()

const originalLog = console.log
console.log = (...args: any[]) => {
	originalLog(...args)
	SOCKETS.forEach((e) => {})
}

async function bootstrap() {
	const app = await NestFactory.create<NestExpressApplication>(AppModule)

	app.useGlobalPipes(new ValidationPipe())
	app.use(LoggerMiddleware)

	const config = new DocumentBuilder()
		.setTitle("Gezcez.com Public API Documentation")
		.setDescription("Public API docs for Gezcez.com")
		.setVersion("1.0.0")
		.setContact("phasenull.dev", "https://phasenull.dev", "contact@phasenull.dev")
		.build()

	const document = SwaggerModule.createDocument(app, config)
	app.use(
		"/docs",
		apiReference({
			theme:"bluePlanet",
			content: document,
		})
	)
	SwaggerModule.setup("swagger", app, document)

	await app.listen(process.env.PORT || 80)
	console.log(`Application is running on: ${await app.getUrl()}`)
}
bootstrap()
