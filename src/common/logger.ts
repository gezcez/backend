// logger.ts
// pino setup (plan section 10.1): JSON to stdout, redaction of secrets and coordinates, and a
// ring buffer of the last lines for the `ops.logs` WS channel. No console.log patching.

import type { IncomingMessage, ServerResponse } from "node:http"
import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino"
import type { Params } from "nestjs-pino"
import type { AppConfig } from "./config"

export const REDACT_PATHS = [
	"req.headers.authorization",
	"req.headers.cookie",
	'res.headers["set-cookie"]',
	"*.token",
	"*.access_token",
	"*.refresh_token",
	"*.code",
	"*.password",
	"*.new_password",
	"*.client_secret",
	"req.query.lat",
	"req.query.lon",
]

/** Keeps the last `capacity` serialised log lines in memory. */
export class LogRingBuffer implements DestinationStream {
	private readonly lines: string[] = []

	constructor(private readonly capacity = 2000) {}

	write(line: string): void {
		this.lines.push(line.trimEnd())
		if (this.lines.length > this.capacity)
			this.lines.splice(0, this.lines.length - this.capacity)
	}

	tail(count = this.capacity): string[] {
		return this.lines.slice(-count)
	}

	get size(): number {
		return this.lines.length
	}
}

export const logRing = new LogRingBuffer()

export function loggerOptions(config: Pick<AppConfig, "logLevel" | "env">): LoggerOptions {
	return {
		level: config.logLevel,
		base: { env: config.env },
		redact: { paths: REDACT_PATHS, censor: "[redacted]" },
		timestamp: pino.stdTimeFunctions.isoTime,
		formatters: { level: (label) => ({ level: label }) },
	}
}

export function createLogger(config: Pick<AppConfig, "logLevel" | "env">): Logger {
	if (config.logLevel === "silent") return pino({ level: "silent" })
	const streams = pino.multistream([
		{ stream: process.stdout, level: config.logLevel },
		{ stream: logRing, level: config.logLevel },
	])
	return pino(loggerOptions(config), streams)
}

function withRequestContext(req: IncomingMessage, value: object): object {
	const r = req as IncomingMessage & {
		route?: { path?: string }
		auth?: { publicId?: string; clientId?: string }
	}
	return {
		...value,
		route: r.route?.path,
		user_public_id: r.auth?.publicId,
		client_id: r.auth?.clientId,
	}
}

/** nestjs-pino parameters: one log line per request with the request id and route template. */
export function pinoHttpParams(config: AppConfig): Params {
	const logger = createLogger(config)
	return {
		pinoHttp: {
			logger,
			genReqId: (req: IncomingMessage) => (req as IncomingMessage & { id?: string }).id ?? "",
			// Added once, when the response is logged, so the route template is known.
			customSuccessObject: (req: IncomingMessage, _res: ServerResponse, value: object) =>
				withRequestContext(req, value),
			customErrorObject: (
				req: IncomingMessage,
				_res: ServerResponse,
				_error: Error,
				value: object,
			) => withRequestContext(req, value),
			customLogLevel: (_req: IncomingMessage, res: ServerResponse, error?: Error) => {
				if (error || res.statusCode >= 500) return "error"
				if (res.statusCode >= 400) return "warn"
				return "info"
			},
			autoLogging: {
				// Health probes and nearby-stop lookups (coordinates) are never logged.
				ignore: (req: IncomingMessage) =>
					req.url === "/health" ||
					req.url === "/ready" ||
					(req.url ?? "").startsWith("/v1/stops/nearby") ||
					// Telemetry is anonymous by design: no access log line with an IP for it.
					(req.url ?? "").startsWith("/v1/telemetry"),
			},
			serializers: {
				req: (req: { method: string; url: string; id: string }) => ({
					id: req.id,
					method: req.method,
					url: (req.url ?? "").split("?")[0],
				}),
				res: (res: { statusCode: number }) => ({ status: res.statusCode }),
			},
		},
	}
}
