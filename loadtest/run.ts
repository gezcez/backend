// loadtest/run.ts
// Load test runner. Boots the API with PROVIDER_REPLAY=kentkart and the fake fleet padded to
// --vehicles (or targets --base-url), runs the scenarios and writes JSON plus Markdown tables.
//
//   bun run loadtest                                   all scenarios, defaults below
//   bun run loadtest --only ws --ws-clients 100,500    one scenario, custom sizes
//   bun run loadtest --base-url http://host:8080 --pid 1234   an already running server
//
// A running server needs NODE_ENV=test (token scenario), PROVIDER_REPLAY=kentkart,
// FAKE_VEHICLES, TRUST_CF_HEADERS=true and a high RATE_LIMIT_SCALE; lib/server.ts sets them.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { markdown, type RunReport } from "./lib/report"
import { startServer, waitFor, type RunningServer } from "./lib/server"
import { restScenario } from "./scenarios/rest"
import { tokenScenario } from "./scenarios/token"
import { wsScenario } from "./scenarios/ws"

const { values } = parseArgs({
	options: {
		only: { type: "string", default: "rest,ws,token" },
		"base-url": { type: "string" },
		pid: { type: "string" },
		port: { type: "string", default: "18090" },
		vehicles: { type: "string", default: "2000" },
		poll: { type: "string", default: "15" },
		"rest-concurrency": { type: "string", default: "32" },
		"rest-duration": { type: "string", default: "10" },
		"ws-clients": { type: "string", default: "100,500,1000,2000" },
		"ws-window": { type: "string", default: "48" },
		"ws-batch": { type: "string", default: "50" },
		families: { type: "string", default: "100" },
		rounds: { type: "string", default: "5" },
		"token-duration": { type: "string", default: "10" },
		"token-concurrency": { type: "string", default: "16" },
		duplicates: { type: "string", default: "20" },
		out: { type: "string", default: path.join(import.meta.dir, "results") },
		"server-log": { type: "string" },
	},
})

const log = (line: string) => process.stdout.write(`${line}\n`)
const only = new Set(values.only.split(","))
const vehicles = Number(values.vehicles)
const pollIntervalS = Number(values.poll)

let server: RunningServer | undefined
const baseUrl =
	values["base-url"] ??
	(server = await startServer({
		port: Number(values.port),
		vehicles,
		pollIntervalS,
		log: values["server-log"],
	})).url
const serverPid = values.pid ? Number(values.pid) : server?.pid
log(`server ${baseUrl} pid ${serverPid ?? "?"}`)

try {
	const cities = (await (await fetch(`${baseUrl}/v1/cities`)).json()) as {
		data: { slug: string; centre: [number, number]; networks: { id: number; status: string }[] }[]
	}
	const city = cities.data.find((c) => c.networks.some((n) => n.status !== "disabled"))!
	const networkId = city.networks.find((n) => n.status !== "disabled")!.id
	const [lon, lat] = city.centre
	log(`city ${city.slug}, network ${networkId}; waiting for ${vehicles} live vehicles`)
	await waitFor(
		async () => {
			const res = (await (
				await fetch(`${baseUrl}/v1/networks/${networkId}/vehicles`)
			).json()) as { data: { vehicles: unknown[] } }
			return res.data.vehicles.length >= vehicles
		},
		120_000,
		"live vehicles",
	)
	const nearby = (await (
		await fetch(`${baseUrl}/v1/stops/nearby?lat=${lat}&lon=${lon}&radius=1000&limit=1`)
	).json()) as { data: { items: { id: string }[] } }
	const stopId = nearby.data.items[0]!.id

	const report: RunReport = {
		startedAt: new Date().toISOString(),
		machine: `${os.cpus().length} x ${os.cpus()[0]?.model ?? "cpu"}, ${Math.round(os.totalmem() / 2 ** 30)} GB, Bun ${Bun.version}`,
		vehicles,
		pollIntervalS,
	}

	if (only.has("rest")) {
		log("rest ...")
		report.rest = await restScenario({
			baseUrl,
			serverPid,
			concurrency: Number(values["rest-concurrency"]),
			durationS: Number(values["rest-duration"]),
			city: city.slug,
			networkId,
			stopId,
			lat,
			lon,
		})
	}
	if (only.has("ws")) {
		report.ws = []
		for (const clients of values["ws-clients"].split(",").map(Number)) {
			log(`ws ${clients} clients ...`)
			report.ws.push(
				await wsScenario({
					baseUrl,
					serverPid,
					clients,
					networkId,
					windowS: Number(values["ws-window"]),
					connectBatch: Number(values["ws-batch"]),
				}),
			)
			// Let closed sockets drain before the next size.
			await Bun.sleep(3000)
		}
	}
	if (only.has("token")) {
		log("token ...")
		report.token = await tokenScenario({
			baseUrl,
			serverPid,
			families: Number(values.families),
			rounds: Number(values.rounds),
			durationS: Number(values["token-duration"]),
			concurrency: Number(values["token-concurrency"]),
			duplicates: Number(values.duplicates),
			email: "rider@test.gezcez.com",
		})
	}

	fs.mkdirSync(values.out, { recursive: true })
	const stamp = report.startedAt.replace(/[:.]/g, "-")
	fs.writeFileSync(path.join(values.out, `${stamp}.json`), JSON.stringify(report, null, "\t"))
	const md = markdown(report)
	fs.writeFileSync(path.join(values.out, `${stamp}.md`), md)
	log("")
	log(md)
} finally {
	await server?.stop()
}
