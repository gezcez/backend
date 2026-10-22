// lib/server.ts
// Boots `bun src/main.ts` the way the load test needs it: a fresh DATA_DIR seeded with the local
// catalog (Kocaeli with its kentkart:004 binding), PROVIDER_REPLAY=kentkart so that binding runs
// on the fake provider padded to FAKE_VEHICLES, and NODE_ENV=test for the seeded e2e_client,
// fixture users and the test mailbox (the token scenario signs in through it).

import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")

export interface ServerOptions {
	port: number
	vehicles: number
	pollIntervalS: number
	/** Extra env for the server (overrides the defaults below). */
	env?: Record<string, string>
	log?: string
}

export interface RunningServer {
	url: string
	pid: number
	dataDir: string
	stop(): Promise<void>
}

function sh(args: string[], env: Record<string, string>): void {
	const result = Bun.spawnSync(args, { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" })
	if (result.exitCode !== 0)
		throw new Error(`${args.join(" ")} failed: ${result.stderr.toString()}`)
}

/** Environment without the caller's Bun flags, so the server runs like the image does. */
function baseEnv(): Record<string, string> {
	const env: Record<string, string> = {}
	for (const [key, value] of Object.entries(process.env))
		if (value !== undefined && key !== "BUN_OPTIONS") env[key] = value
	return env
}

/**
 * Seeds the local catalog, then soft-deletes a fake:kocaeli placeholder binding so the
 * NODE_ENV=test boot seed does not attach a second (fake) binding to the same network.
 */
function prepareData(dataDir: string, pollIntervalS: number, env: Record<string, string>): void {
	sh(["bun", "scripts/seed.ts", "--env", "local"], { ...env, DATA_DIR: dataDir })
	const db = new Database(path.join(dataDir, "core.db"))
	const now = Date.now()
	db.run(
		`UPDATE provider_bindings SET poll_interval_s = ?, idle_poll_interval_s = ?
		 WHERE provider_key = 'kentkart'`,
		[pollIntervalS, pollIntervalS],
	)
	db.run(
		`INSERT OR IGNORE INTO provider_bindings
		 (network_id, provider_key, external_ref, status, created_at, deleted_at)
		 SELECT network_id, 'fake', 'kocaeli', 'disabled', ?, ? FROM provider_bindings
		 WHERE provider_key = 'kentkart' LIMIT 1`,
		[now, now],
	)
	db.close()
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gezcez-loadtest-"))
	const env = baseEnv()
	prepareData(dataDir, options.pollIntervalS, env)
	const url = `http://127.0.0.1:${options.port}`
	const serverEnv: Record<string, string> = {
		...env,
		NODE_ENV: "test",
		HOST: "127.0.0.1",
		PORT: String(options.port),
		PUBLIC_API_URL: url,
		DATA_DIR: dataDir,
		MIGRATIONS_DIR: path.join(REPO_ROOT, "drizzle"),
		PROVIDER_REPLAY: "kentkart",
		FAKE_VEHICLES: String(options.vehicles),
		// Every socket comes from 127.0.0.1; clients send distinct CF-Connecting-IP values.
		TRUST_CF_HEADERS: "true",
		// Measure the handlers, not the limiter (ratelimit.e2e.ts covers the limits).
		RATE_LIMIT_SCALE: "100000",
		LOG_LEVEL: "warn",
		TRACKER_QUIET_HOURS: "off",
		ARCHIVE_EXPORT_AT: "off",
		AGGREGATES_AT: "off",
		...options.env,
	}
	const logFd = options.log ? fs.openSync(options.log, "w") : "ignore"
	const proc = Bun.spawn(["bun", "src/main.ts"], {
		cwd: REPO_ROOT,
		env: serverEnv,
		stdout: logFd,
		stderr: logFd,
	})
	const stop = async () => {
		proc.kill("SIGTERM")
		await Promise.race([proc.exited, Bun.sleep(5000)])
		if (proc.exitCode === null) proc.kill("SIGKILL")
		fs.rmSync(dataDir, { recursive: true, force: true })
	}
	try {
		await waitFor(async () => (await fetch(`${url}/ready`)).ok, 60_000, "server ready")
	} catch (error) {
		await stop()
		throw error
	}
	return { url, pid: proc.pid, dataDir, stop }
}

export async function waitFor(
	check: () => Promise<boolean>,
	timeoutMs: number,
	what: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			if (await check()) return
		} catch {
			// not up yet
		}
		await Bun.sleep(250)
	}
	throw new Error(`timed out waiting for ${what}`)
}
