// tracker.worker.ts
// Bun Worker entry for the tracker (MODE=all, plan 3.1 and 8.10). It builds its own Nest
// application context: core.db and transit.db read-only, vts.db read-write (sole writer).
// Messages are typed in services/tracker/tracker.types.ts. Started by TrackerHostService.

import "reflect-metadata"
import { Module, type DynamicModule } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import { Logger as PinoLogger, LoggerModule } from "nestjs-pino"
import { ConfigModule, type AppConfig } from "@common/config"
import { pinoHttpParams } from "@common/logger"
import { DatabaseModule } from "@db"
import { NetworksCoreModule } from "@services/networks/networks-core.module"
import { ProvidersModule } from "@services/providers/providers.module"
import { TrackerCoreModule } from "@services/tracker/tracker-core.module"
import { TrackerService } from "@services/tracker/tracker.service"
import type { MainToWorker, WorkerToMain } from "@services/tracker/tracker.types"

interface WorkerScope {
	postMessage(message: WorkerToMain): void
	addEventListener(type: "message", listener: (event: MessageEvent<MainToWorker>) => void): void
	close(): void
}

const scope = globalThis as unknown as WorkerScope

@Module({})
class TrackerWorkerModule {
	static forRoot(config: AppConfig): DynamicModule {
		return {
			module: TrackerWorkerModule,
			imports: [
				ConfigModule.forRoot(config),
				LoggerModule.forRoot(pinoHttpParams(config)),
				DatabaseModule.withOptions({ core: "ro", transit: "ro", vts: "rw", seed: false }),
				ProvidersModule.forRoot({ persistTokens: true }),
				NetworksCoreModule,
				TrackerCoreModule,
			],
		}
	}
}

let tracker: TrackerService | undefined
let close: (() => Promise<void>) | undefined

async function boot(config: AppConfig): Promise<void> {
	const app = await NestFactory.createApplicationContext(TrackerWorkerModule.forRoot(config), {
		bufferLogs: true,
		logger: config.logLevel === "silent" ? false : undefined,
	})
	if (config.logLevel !== "silent") app.useLogger(app.get(PinoLogger))
	app.enableShutdownHooks()
	const engine = app.get(TrackerService)
	tracker = engine
	engine.onUpdate((update) => scope.postMessage({ type: "update", update }))
	engine.onStatus((status) => scope.postMessage({ type: "status", status }))
	engine.onLog((bindingId, level, message) =>
		scope.postMessage({ type: "log", binding_id: bindingId, level, message }),
	)
	engine.start({ schedule: config.transit.trackerRunner !== "manual", refTimers: true })
	close = async () => {
		await engine.stop()
		await app.close()
	}
	scope.postMessage({ type: "ready", statuses: engine.statuses(), live: engine.liveSets() })
}

scope.addEventListener("message", (event) => {
	const message = event.data
	switch (message.type) {
		case "init":
			boot(message.config as AppConfig).catch((error: unknown) => {
				scope.postMessage({
					type: "fatal",
					message:
						error instanceof Error ? (error.stack ?? error.message) : String(error),
				})
			})
			break
		case "control":
			if (!tracker) {
				scope.postMessage({
					type: "ack",
					id: message.id,
					result: { ok: false, error: "Tracker is starting" },
				})
				break
			}
			tracker
				.control(message.control)
				.then((result) => scope.postMessage({ type: "ack", id: message.id, result }))
				.catch((error: unknown) =>
					scope.postMessage({
						type: "ack",
						id: message.id,
						result: { ok: false, error: (error as Error).message },
					}),
				)
			break
		case "subscribers":
			tracker?.setSubscribers(message.counts)
			break
		case "stop":
			void (async () => {
				try {
					await close?.()
				} finally {
					scope.postMessage({ type: "stopped" })
					scope.close()
				}
			})()
			break
	}
})
