// main.ts
// Process entry. Only bootstraps; nothing imports this file.

import "reflect-metadata"
import { ConfigError, loadConfig } from "@common/config"
import { createApp, mountDocs } from "./app.factory"

async function bootstrap(): Promise<void> {
	let config
	try {
		config = loadConfig()
	} catch (error) {
		if (error instanceof ConfigError) {
			process.stderr.write(`${error.message}\n`)
			process.exit(78)
		}
		throw error
	}
	const app = await createApp(config)
	mountDocs(app, config)
	await app.listen(config.port, config.host)
}

bootstrap().catch((error: unknown) => {
	process.stderr.write(
		`Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
	)
	process.exit(1)
})
