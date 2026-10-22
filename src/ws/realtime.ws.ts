// realtime.ws.ts
// The one WebSocket protocol for the dashboard and the rider app (plan 6.10), on the HTTP
// server's upgrade event at /v1/ws. Raw `ws`, JSON text frames. Public channels work
// anonymously; staff channels and `detail: "full"` need an `auth` message with a dash token.
// Nothing sensitive is ever read from the URL.

import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import {
	Inject,
	Injectable,
	Logger,
	type BeforeApplicationShutdown,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common"
import { HttpAdapterHost } from "@nestjs/core"
import { WebSocket, WebSocketServer, type RawData } from "ws"
import { z } from "zod"
import { BEARER_AUTH, type BearerAuthProvider } from "@common/auth.types"
import { hasPermission, PERMISSION_RESOLVER, type PermissionResolver } from "@common/authorization"
import { InjectConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"
import type { RequestAuth } from "@common/jwt.types"
import { registerOpenApiDecorator } from "@common/openapi"
import { parsePublicRef, publicRef } from "@common/utils"
import { NetworksService } from "@services/networks/networks.service"
import { LiveFeedBus } from "@services/tracker/live-feed.bus"
import { statusView } from "@services/tracker/tracker.dto"
import { TrackerHostService, type TrackerLogLine } from "@services/tracker/tracker-host.service"
import type { BindingStatus, FeedUpdate } from "@services/tracker/tracker.types"
import {
	VehiclesService,
	type VehicleDetail,
	type VehicleFilter,
} from "@services/vehicles/vehicles.service"
import {
	DeparturesParamsSchema,
	TrackerLogsParamsSchema,
	TrackerStatusParamsSchema,
	VehiclesParamsSchema,
	WS_CLOSE,
	WS_LIMITS,
	WS_PATH,
	WS_PROTOCOL_VERSION,
	WsClientMessageSchema,
	WsServerMessageSchema,
	type WsClientMessage,
	type WsServerMessage,
} from "./ws.protocol"

export const HEARTBEAT_S = 20
const BACKPRESSURE_BYTES = 1024 * 1024
const MAX_SOCKETS = 20_000
const MAX_VIOLATIONS = 5
const HARD_MAX_PAYLOAD = 64 * 1024
const SUBSCRIBER_REPORT_MS = 15_000

interface BaseSub {
	id: string
	seq: number
}
interface VehiclesSub extends BaseSub {
	channel: "vehicles"
	filter: VehicleFilter
	detail: VehicleDetail
	staff: boolean
	/** vehicle_id to external id of what the client currently holds. */
	known: Map<number, string>
	/** A delta was dropped under backpressure: send a snapshot when the socket drains. */
	stale: boolean
}
interface DeparturesSub extends BaseSub {
	channel: "departures"
	stopId: string
	bindingId: number
	limit: number
	staff: false
}
interface TrackerStatusSub extends BaseSub {
	channel: "tracker.status"
	networkId: number | null
	staff: true
}
interface TrackerLogsSub extends BaseSub {
	channel: "tracker.logs"
	bindingId: number
	staff: true
}
type Sub = VehiclesSub | DeparturesSub | TrackerStatusSub | TrackerLogsSub

interface Client {
	ws: WebSocket
	ip: string
	auth: RequestAuth | null
	authTimer: ReturnType<typeof setTimeout> | undefined
	subs: Map<string, Sub>
	missedPongs: number
	messageTimes: number[]
	subscribeTimes: number[]
	violations: number
}

function clientIp(req: IncomingMessage, trustCf: boolean): string {
	if (trustCf) {
		const header = req.headers["cf-connecting-ip"]
		const value = Array.isArray(header) ? header[0] : header
		if (value) return value.trim()
	}
	const raw = req.socket.remoteAddress ?? "unknown"
	return raw.startsWith("::ffff:") ? raw.slice(7) : raw
}

// Publish the protocol in openapi.json (plan 4.1) so clients generate their socket types.
registerOpenApiDecorator((document) => {
	document.components ??= {}
	const toSchema = (schema: z.ZodType) => {
		const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
			target: "draft-2020-12",
			io: "input",
		}) as Record<string, unknown>
		return rest
	}
	document.components.schemas = {
		...document.components.schemas,
		WsClientMessage: toSchema(WsClientMessageSchema),
		WsServerMessage: toSchema(WsServerMessageSchema),
		WsVehiclesParams: toSchema(VehiclesParamsSchema),
		WsDeparturesParams: toSchema(DeparturesParamsSchema),
	}
})

@Injectable()
export class RealtimeGateway
	implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
	private readonly logger = new Logger("Realtime")
	private readonly wss = new WebSocketServer({
		noServer: true,
		maxPayload: HARD_MAX_PAYLOAD,
		perMessageDeflate: false,
	})
	private readonly clients = new Set<Client>()
	private readonly perIp = new Map<string, number>()
	private heartbeat: ReturnType<typeof setInterval> | undefined
	private reporter: ReturnType<typeof setInterval> | undefined
	private lastCounts = ""
	private server: Server | undefined
	private readonly unsubscribers: (() => void)[] = []
	private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) =>
		this.upgrade(req, socket, head)

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly adapterHost: HttpAdapterHost,
		@Inject(BEARER_AUTH) private readonly bearer: BearerAuthProvider,
		@Inject(PERMISSION_RESOLVER) private readonly permissions: PermissionResolver,
		private readonly vehicles: VehiclesService,
		private readonly bus: LiveFeedBus,
		private readonly host: TrackerHostService,
		private readonly networks: NetworksService,
	) {}

	onApplicationBootstrap(): void {
		this.server = this.adapterHost.httpAdapter.getHttpServer() as Server
		this.server.on("upgrade", this.onUpgrade)
		this.unsubscribers.push(
			this.bus.subscribe((update) => this.onFeedUpdate(update)),
			this.host.onStatusChange((status) => this.onStatus(status)),
			this.host.onLogLine((line) => this.onLog(line)),
		)
		this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_S * 1000)
		this.heartbeat.unref?.()
		this.reporter = setInterval(() => this.reportSubscribers(false), SUBSCRIBER_REPORT_MS)
		this.reporter.unref?.()
	}

	/** Sends 1001 to every socket, then drops the ones that do not finish the close handshake. */
	async beforeApplicationShutdown(): Promise<void> {
		this.server?.off("upgrade", this.onUpgrade)
		for (const unsubscribe of this.unsubscribers) unsubscribe()
		if (this.heartbeat) clearInterval(this.heartbeat)
		if (this.reporter) clearInterval(this.reporter)
		const sockets = [...this.clients].map((c) => c.ws)
		for (const ws of sockets) ws.close(WS_CLOSE.goingAway, "server restarting")
		if (sockets.length) await Bun.sleep(200)
		for (const ws of sockets) if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
		this.wss.close()
	}

	onApplicationShutdown(): void {
		this.wss.close()
	}

	// ---- connection ---------------------------------------------------------------------------

	private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		const path = (req.url ?? "").split("?")[0]
		if (path !== WS_PATH) {
			socket.destroy()
			return
		}
		const ip = clientIp(req, this.config.trustCfHeaders)
		this.wss.handleUpgrade(req, socket, head, (ws) => {
			if (this.clients.size >= MAX_SOCKETS) {
				ws.close(WS_CLOSE.overloaded, "overloaded, try later")
				return
			}
			if ((this.perIp.get(ip) ?? 0) >= WS_LIMITS.sockets_per_ip) {
				ws.close(WS_CLOSE.rateLimited, "too many connections")
				return
			}
			this.connect(ws, ip)
		})
	}

	private connect(ws: WebSocket, ip: string): void {
		const client: Client = {
			ws,
			ip,
			auth: null,
			authTimer: undefined,
			subs: new Map(),
			missedPongs: 0,
			messageTimes: [],
			subscribeTimes: [],
			violations: 0,
		}
		this.clients.add(client)
		this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1)
		ws.on("message", (data, isBinary) => void this.onMessage(client, data, isBinary))
		ws.on("close", () => this.disconnect(client))
		ws.on("error", () => ws.terminate())
		this.send(client, {
			type: "hello",
			v: WS_PROTOCOL_VERSION,
			heartbeat_s: HEARTBEAT_S,
			limits: {
				max_subs: WS_LIMITS.max_subs,
				max_routes_per_sub: WS_LIMITS.max_routes_per_sub,
				max_bbox_span_deg: WS_LIMITS.max_bbox_span_deg,
			},
		})
	}

	private disconnect(client: Client): void {
		if (!this.clients.delete(client)) return
		if (client.authTimer) clearTimeout(client.authTimer)
		const left = (this.perIp.get(client.ip) ?? 1) - 1
		if (left <= 0) this.perIp.delete(client.ip)
		else this.perIp.set(client.ip, left)
		if (client.subs.size) this.reportSubscribers(false)
	}

	private send(client: Client, message: WsServerMessage): void {
		if (client.ws.readyState !== WebSocket.OPEN) return
		client.ws.send(JSON.stringify(message))
	}

	private error(client: Client, code: string, message: string, id?: string): void {
		this.send(client, { type: "error", ...(id ? { id } : {}), code, message })
	}

	private violation(client: Client, message: string, id?: string): void {
		client.violations++
		this.error(client, "RATE_LIMITED", message, id)
		if (client.violations >= MAX_VIOLATIONS)
			client.ws.close(WS_CLOSE.rateLimited, "rate limited")
	}

	private beat(): void {
		const t = Date.now()
		for (const client of this.clients) {
			if (client.missedPongs >= 2) {
				client.ws.terminate()
				continue
			}
			client.missedPongs++
			this.send(client, { type: "ping", t })
		}
	}

	// ---- client messages ----------------------------------------------------------------------

	private async onMessage(client: Client, data: RawData, isBinary: boolean): Promise<void> {
		const now = Date.now()
		client.missedPongs = 0
		client.messageTimes = client.messageTimes.filter((t) => now - t < 10_000)
		client.messageTimes.push(now)
		if (client.messageTimes.length > WS_LIMITS.messages_per_10s) {
			this.violation(client, "Too many messages")
			return
		}
		const raw = Buffer.isBuffer(data)
			? data
			: Array.isArray(data)
				? Buffer.concat(data)
				: Buffer.from(data)
		if (raw.byteLength > WS_LIMITS.max_message_bytes) {
			this.violation(client, "Message too large")
			return
		}
		let message: WsClientMessage
		try {
			if (isBinary) throw new Error("binary")
			message = WsClientMessageSchema.parse(JSON.parse(raw.toString("utf8")))
		} catch {
			client.ws.close(WS_CLOSE.malformed, "malformed message")
			return
		}
		switch (message.type) {
			case "ping":
				this.send(client, { type: "pong", t: message.t })
				return
			case "pong":
				return
			case "auth":
				await this.authenticate(client, message.token)
				return
			case "unsubscribe":
				if (client.subs.delete(message.id)) this.reportSubscribers(false)
				return
			case "subscribe":
				client.subscribeTimes = client.subscribeTimes.filter((t) => now - t < 60_000)
				client.subscribeTimes.push(now)
				if (client.subscribeTimes.length > WS_LIMITS.subscribes_per_minute) {
					this.violation(client, "Too many subscribe messages", message.id)
					return
				}
				try {
					this.subscribe(client, message.id, message.channel, message.params)
				} catch (error) {
					if (error instanceof GezcezError)
						this.error(client, error.code, error.message, message.id)
					else if (error instanceof z.ZodError)
						this.error(client, "VALIDATION_FAILED", z.prettifyError(error), message.id)
					else {
						this.logger.error(`subscribe failed: ${(error as Error).message}`)
						this.error(client, "INTERNAL", "Subscription failed", message.id)
					}
				}
				return
		}
	}

	private async authenticate(client: Client, token: string): Promise<void> {
		let auth: RequestAuth
		try {
			auth = await this.bearer.authenticate(token)
		} catch {
			client.ws.close(WS_CLOSE.authInvalid, "auth invalid")
			return
		}
		client.auth = auth
		if (client.authTimer) clearTimeout(client.authTimer)
		const ms = Math.max(0, auth.exp * 1000 - Date.now())
		client.authTimer = setTimeout(() => this.expire(client), Math.min(ms, 2 ** 31 - 1))
		client.authTimer.unref?.()
		this.send(client, { type: "auth_ok", exp: auth.exp })
	}

	/** Token expired without a new `auth`: staff subscriptions end, public ones keep running. */
	private expire(client: Client): void {
		client.auth = null
		for (const sub of [...client.subs.values()]) {
			if (!sub.staff) continue
			client.subs.delete(sub.id)
			this.error(
				client,
				"AUTH_TOKEN_EXPIRED",
				"Access token expired; send auth again",
				sub.id,
			)
		}
	}

	private requirePermission(
		client: Client,
		key: "vehicles.live.read" | "tracker.read",
		networkId?: number,
	): void {
		if (!client.auth) throw new GezcezError("AUTH_REQUIRED", "Send an auth message first")
		if (!client.auth.scopes.includes("dash"))
			throw new GezcezError("SCOPE_MISSING", "Token lacks the dash scope")
		const permissions = this.permissions.forUser(client.auth.userId)
		if (!hasPermission(permissions, key, networkId))
			throw new GezcezError("PERMISSION_MISSING", `Missing ${key}`)
	}

	private subscribe(client: Client, id: string, channel: string, params: unknown): void {
		if (!client.subs.has(id) && client.subs.size >= WS_LIMITS.max_subs)
			throw new GezcezError("RATE_LIMITED", `At most ${WS_LIMITS.max_subs} subscriptions`)
		const previous = client.subs.get(id)
		let sub: Sub
		switch (channel) {
			case "vehicles": {
				const p = VehiclesParamsSchema.parse(params)
				const filter = this.vehicles.filter({
					network: p.network,
					routes: p.routes,
					direction: p.direction,
					bbox: p.bbox,
				})
				if (p.detail === "full")
					this.requirePermission(client, "vehicles.live.read", filter.network.id)
				sub = {
					channel: "vehicles",
					id,
					seq: previous?.seq ?? 0,
					filter,
					detail: p.detail,
					staff: p.detail === "full",
					known: new Map(),
					stale: false,
				}
				client.subs.set(id, sub)
				this.snapshot(client, sub)
				for (const bindingId of filter.bindingIds) {
					const status = this.host.status(bindingId)
					if (status && status.state !== "ok" && status.state !== "unknown")
						this.sendStatus(client, sub, status)
				}
				break
			}
			case "departures": {
				const p = DeparturesParamsSchema.parse(params)
				const ref = parsePublicRef(p.stop)
				if (!ref) throw new GezcezError("NOT_FOUND", "Stop not found")
				sub = {
					channel: "departures",
					id,
					seq: previous?.seq ?? 0,
					stopId: p.stop,
					bindingId: ref.bindingId,
					limit: p.limit,
					staff: false,
				}
				// Resolve first so an unknown stop fails the subscribe, not later deliveries.
				const result = this.vehicles.departures(p.stop, p.limit)
				client.subs.set(id, sub)
				this.sendDepartures(client, sub, result)
				break
			}
			case "tracker.status": {
				const p = TrackerStatusParamsSchema.parse(params)
				const networkId = p.network ? this.networks.network(p.network, false).id : null
				this.requirePermission(client, "tracker.read", networkId ?? undefined)
				sub = {
					channel: "tracker.status",
					id,
					seq: previous?.seq ?? 0,
					networkId,
					staff: true,
				}
				client.subs.set(id, sub)
				const bindings = this.bindingsOf(networkId)
				this.event(client, sub, {
					kind: "snapshot",
					bindings: bindings.map((b) => statusView(this.statusOr(b))),
				})
				break
			}
			case "tracker.logs": {
				const p = TrackerLogsParamsSchema.parse(params)
				const binding = this.networks.binding(p.binding)
				this.requirePermission(client, "tracker.read", binding.network_id)
				sub = {
					channel: "tracker.logs",
					id,
					seq: previous?.seq ?? 0,
					bindingId: binding.id,
					staff: true,
				}
				client.subs.set(id, sub)
				for (const line of this.host.recentLogs(binding.id).slice(-100))
					this.event(client, sub, line)
				break
			}
			default:
				throw new GezcezError("VALIDATION_FAILED", `Unknown channel ${channel}`)
		}
		this.reportSubscribers(false)
	}

	private bindingsOf(networkId: number | null): number[] {
		return this.networks.bindings(networkId ?? undefined).map((b) => b.id)
	}

	private statusOr(bindingId: number): BindingStatus {
		return (
			this.host.status(bindingId) ?? {
				binding_id: bindingId,
				state: "unknown",
				message: null,
				last_feed_ts: this.bus.lastFeedTs(bindingId),
				last_poll_at: null,
				last_outcome: null,
				consecutive_failures: 0,
				next_poll_at: null,
				interval_s: null,
				url_variant: null,
				live_vehicles: this.bus.count(bindingId),
				subscribers: 0,
				credentials: null,
			}
		)
	}

	// ---- server messages ----------------------------------------------------------------------

	private snapshot(client: Client, sub: VehiclesSub): void {
		const list = this.vehicles.select(sub.filter)
		sub.known = new Map(list.map((v) => [v.vehicle_id, v.external_id]))
		sub.stale = false
		this.send(client, {
			type: "snapshot",
			sub: sub.id,
			seq: ++sub.seq,
			feed_ts: this.vehicles.feedTs(sub.filter),
			fields: [...this.vehicles.fields(sub.detail)],
			vehicles: list.map((v) => this.vehicles.row(v, sub.detail)),
		})
	}

	private sendStatus(client: Client, sub: VehiclesSub, status: BindingStatus): void {
		this.send(client, {
			type: "status",
			sub: sub.id,
			seq: ++sub.seq,
			network: sub.filter.network.id,
			binding: status.binding_id,
			state: status.state,
			message: status.message,
		})
	}

	private sendDepartures(
		client: Client,
		sub: DeparturesSub,
		result: ReturnType<VehiclesService["departures"]>,
	): void {
		this.send(client, {
			type: "departures",
			sub: sub.id,
			seq: ++sub.seq,
			stop: sub.stopId,
			generated_at: result.generated_at,
			items: result.items,
		})
	}

	private event(client: Client, sub: TrackerStatusSub | TrackerLogsSub, data: unknown): void {
		this.send(client, { type: "event", sub: sub.id, seq: ++sub.seq, data })
	}

	private onFeedUpdate(update: FeedUpdate): void {
		const departures = new Map<string, ReturnType<VehiclesService["departures"]> | null>()
		for (const client of this.clients) {
			const congested = client.ws.bufferedAmount > BACKPRESSURE_BYTES
			for (const sub of client.subs.values()) {
				if (sub.channel === "vehicles") {
					if (!sub.filter.bindingIds.has(update.binding_id)) continue
					if (congested) {
						sub.stale = true
						continue
					}
					if (sub.stale || update.reset) {
						this.snapshot(client, sub)
						continue
					}
					this.delta(client, sub, update)
				} else if (sub.channel === "departures" && sub.bindingId === update.binding_id) {
					if (congested) continue
					const key = `${sub.stopId}|${sub.limit}`
					if (!departures.has(key)) {
						try {
							departures.set(key, this.vehicles.departures(sub.stopId, sub.limit))
						} catch {
							departures.set(key, null)
						}
					}
					const result = departures.get(key)
					if (result) this.sendDepartures(client, sub, result)
				}
			}
		}
	}

	private delta(client: Client, sub: VehiclesSub, update: FeedUpdate): void {
		const upsert = []
		const remove: string[] = []
		for (const v of update.upsert) {
			if (this.vehicles.matches(sub.filter, v)) {
				sub.known.set(v.vehicle_id, v.external_id)
				upsert.push(this.vehicles.row(v, sub.detail))
			} else if (sub.known.delete(v.vehicle_id)) {
				// Left the filter (bbox, route change): the client drops it.
				remove.push(publicRef(v.binding_id, v.external_id))
			}
		}
		for (const id of update.remove) {
			const externalId = sub.known.get(id)
			if (externalId === undefined) continue
			sub.known.delete(id)
			remove.push(publicRef(update.binding_id, externalId))
		}
		if (!upsert.length && !remove.length) return
		this.send(client, {
			type: "delta",
			sub: sub.id,
			seq: ++sub.seq,
			feed_ts: update.feed_ts || null,
			upsert,
			remove,
		})
	}

	private onStatus(status: BindingStatus): void {
		for (const client of this.clients) {
			for (const sub of client.subs.values()) {
				if (sub.channel === "vehicles" && sub.filter.bindingIds.has(status.binding_id))
					this.sendStatus(client, sub, status)
				else if (sub.channel === "tracker.status") {
					const binding = this.networks.bindings().find((b) => b.id === status.binding_id)
					if (sub.networkId === null || binding?.network_id === sub.networkId)
						this.event(client, sub, { kind: "status", binding: statusView(status) })
				}
			}
		}
	}

	private onLog(line: TrackerLogLine): void {
		for (const client of this.clients)
			for (const sub of client.subs.values())
				if (sub.channel === "tracker.logs" && sub.bindingId === line.binding_id)
					this.event(client, sub, line)
	}

	/** Active vehicle and departures subscribers per binding, sent to the tracker (plan 8.2). */
	private reportSubscribers(force: boolean): void {
		const counts: Record<number, number> = {}
		for (const client of this.clients)
			for (const sub of client.subs.values()) {
				if (sub.channel === "vehicles")
					for (const id of sub.filter.bindingIds) counts[id] = (counts[id] ?? 0) + 1
				else if (sub.channel === "departures")
					counts[sub.bindingId] = (counts[sub.bindingId] ?? 0) + 1
			}
		const key = JSON.stringify(counts)
		if (!force && key === this.lastCounts) return
		this.lastCounts = key
		this.host.setSubscribers(counts)
	}

	/** Open sockets (metrics, tests). */
	connections(): number {
		return this.clients.size
	}
}
