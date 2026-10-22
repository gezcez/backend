// test/helpers/app.ts
// Boots the real application on a random port against a fresh temp DATA_DIR with real migrations.

import type { NestExpressApplication } from "@nestjs/platform-express"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig, type AppConfig } from "@common/config"
import { createApp, mountDocs } from "../../src/app.factory"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")

export interface TestApp {
	app: NestExpressApplication
	config: AppConfig
	url: string
	dataDir: string
	/** fetch relative to the app's base URL. */
	fetch(pathname: string, init?: RequestInit): Promise<Response>
	/** fetch + parse JSON body. */
	json<T = unknown>(
		pathname: string,
		init?: RequestInit,
	): Promise<{ status: number; headers: Headers; body: T }>
	close(): Promise<void>
}

export function testConfig(dataDir: string, env: Record<string, string> = {}): AppConfig {
	return loadConfig({
		NODE_ENV: "test",
		DATA_DIR: dataDir,
		MIGRATIONS_DIR: path.join(REPO_ROOT, "drizzle"),
		LOG_LEVEL: "silent",
		EMAIL_TRANSPORT: "memory",
		PUBLIC_API_URL: "http://localhost:8080",
		PORT: "0",
		// Suites send many codes from one IP; ratelimit.e2e.ts tests the real limits.
		RATE_LIMIT_SCALE: "50",
		...env,
	})
}

export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gezcez-test-"))
	const config = testConfig(dataDir, env)
	const app = await createApp(config, { quiet: true })
	mountDocs(app, config)
	await app.listen(0, "127.0.0.1")
	const address = app.getHttpServer().address() as { port: number }
	const url = `http://127.0.0.1:${address.port}`
	const doFetch = (pathname: string, init?: RequestInit) => fetch(url + pathname, init)
	return {
		app,
		config,
		url,
		dataDir,
		fetch: doFetch,
		async json<T>(pathname: string, init?: RequestInit) {
			const response = await doFetch(pathname, init)
			const text = await response.text()
			return {
				status: response.status,
				headers: response.headers,
				body: (text ? JSON.parse(text) : null) as T,
			}
		},
		async close() {
			await app.close()
			fs.rmSync(dataDir, { recursive: true, force: true })
		},
	}
}
