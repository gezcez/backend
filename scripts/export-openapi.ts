// export-openapi.ts
// Writes openapi.json at the repo root (committed, release asset, served at /openapi.json).
// `--check` fails when the committed copy is stale, which CI runs on every push.

import "reflect-metadata"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig } from "@common/config"
import { buildOpenApiDocument } from "@common/openapi"
import { createApp } from "../src/app.factory"

const ROOT = path.resolve(import.meta.dir, "..")
const OUTPUT = path.join(ROOT, "openapi.json")
const check = process.argv.includes("--check")

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gezcez-openapi-"))
try {
	const config = loadConfig({
		NODE_ENV: "test",
		DATA_DIR: dataDir,
		MIGRATIONS_DIR: path.join(ROOT, "drizzle"),
		LOG_LEVEL: "silent",
		EMAIL_TRANSPORT: "memory",
		PUBLIC_API_URL: "https://api.gezcez.com",
		TRACKER_RUNNER: "off",
		TRANSIT_SYNC_AT: "off",
	})
	const app = await createApp(config, { quiet: true })
	await app.init()
	const document = buildOpenApiDocument(app, config)
	await app.close()
	const json = `${JSON.stringify(document, null, "\t")}\n`

	if (check) {
		const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : ""
		if (current !== json) {
			console.error(
				"openapi.json is stale. Run `bun run openapi:export` and commit the result.",
			)
			process.exitCode = 1
		} else {
			console.log("openapi.json is up to date.")
		}
	} else {
		fs.writeFileSync(OUTPUT, json)
		console.log(
			`Wrote ${path.relative(process.cwd(), OUTPUT)} (${Object.keys(document.paths).length} paths)`,
		)
	}
} finally {
	fs.rmSync(dataDir, { recursive: true, force: true })
}
