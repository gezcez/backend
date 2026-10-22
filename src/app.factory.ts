// app.factory.ts
// Builds a fully configured Nest application. main.ts, the e2e harness and the OpenAPI export
// script all use this, so tests run exactly what production runs.

import "reflect-metadata"
import { RequestMethod, type INestApplication } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import type { NestExpressApplication } from "@nestjs/platform-express"
import { apiReference } from "@scalar/nestjs-api-reference"
import cookieParser from "cookie-parser"
import type { Request, Response } from "express"
import { Logger as PinoLogger } from "nestjs-pino"
import type { AppConfig } from "@common/config"
import { API_PREFIX } from "@common/constants"
import { corsMiddleware, requestIdMiddleware } from "@common/middlewares"
import { buildOpenApiDocument } from "@common/openapi"
import { AppModule } from "./app.module"

export { API_PREFIX }

// Brand colours (cream, navy, amber) for the API reference page.
const DOCS_CSS = `
.light-mode {
  --scalar-background-1: #fffbeb;
  --scalar-background-2: #fef3c7;
  --scalar-background-3: #fde68a;
  --scalar-color-1: #172554;
  --scalar-color-2: #1e3a8a;
  --scalar-color-accent: #d97706;
  --scalar-button-1: #172554;
  --scalar-button-1-color: #fffbeb;
  --scalar-button-1-hover: #1e3a8a;
}
.dark-mode {
  --scalar-background-1: #0b1230;
  --scalar-background-2: #172554;
  --scalar-background-3: #1e3a8a;
  --scalar-color-1: #fffbeb;
  --scalar-color-accent: #fbbf24;
  --scalar-button-1: #fbbf24;
  --scalar-button-1-color: #172554;
  --scalar-button-1-hover: #d97706;
}
body { font-family: Inter, system-ui, sans-serif; }
`

export interface CreateAppOptions {
	/** Skip binding the pino logger (OpenAPI export prints nothing). */
	quiet?: boolean
}

export async function createApp(
	config: AppConfig,
	options: CreateAppOptions = {},
): Promise<NestExpressApplication> {
	const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
		bufferLogs: true,
		logger: options.quiet ? false : undefined,
		bodyParser: false,
	})
	if (!options.quiet) app.useLogger(app.get(PinoLogger))

	app.disable("x-powered-by")
	app.set("trust proxy", false)
	app.set("query parser", "simple")
	if (config.basePath) {
		const base = config.basePath
		app.use((req: Request, _res: Response, next: () => void) => {
			if (req.url === base || req.url.startsWith(`${base}/`) || req.url.startsWith(`${base}?`))
				req.url = req.url.slice(base.length) || "/"
			next()
		})
	}
	app.use(requestIdMiddleware(config.trustCfHeaders))
	app.useBodyParser("json", { limit: "100kb" })
	app.useBodyParser("urlencoded", { limit: "20kb", extended: false })
	app.use(cookieParser())
	// Per route group, credentials only where a cookie is meant to travel (middlewares/cors.ts).
	app.use(corsMiddleware(config))
	app.setGlobalPrefix(API_PREFIX, {
		exclude: [
			{ path: "health", method: RequestMethod.GET },
			{ path: "ready", method: RequestMethod.GET },
			{ path: ".well-known/openid-configuration", method: RequestMethod.GET },
			{ path: ".well-known/jwks.json", method: RequestMethod.GET },
		],
	})
	app.enableShutdownHooks()
	return app
}

/** Registers /openapi.json and the Scalar reference at /docs. Call after createApp, before listen. */
export function mountDocs(app: INestApplication, config: AppConfig): void {
	const document = buildOpenApiDocument(app, config)
	const http = app.getHttpAdapter()
	http.get("/openapi.json", (_req: Request, res: Response) => {
		res.setHeader("Cache-Control", "public, max-age=300")
		res.json(document)
	})
	app.use(
		"/docs",
		apiReference({
			url: "/openapi.json",
			pageTitle: "gezcez API",
			customCss: DOCS_CSS,
			hideClientButton: false,
		}),
	)
}
