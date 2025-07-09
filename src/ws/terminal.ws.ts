import { logger, OAuthUtils } from "@shared"
import {
	OnGatewayConnection,
	OnGatewayDisconnect,
	OnGatewayInit,
	WebSocketGateway,
	WebSocketServer,
} from "@nestjs/websockets"
import type { WebSocket } from "ws"
import { Server } from "ws"
import { SOCKETS } from ".."

export function BuildWSMessage(
	type: "status" | "message",
	content: string | object | boolean | number,
	color?: "green" | "red"
) {
	return JSON.stringify({
		type: type,
		color: color,
		content: content,
	})
}
export type WebsocketMessage = {
	type: "status" | "message"
	color?: "green" | "red"
	content: string | object | boolean | number
}
@WebSocketGateway({
	path: "/system/terminal",
	cors: "*",
	transport: ["websocket"],
})
export class TerminalWsGateway
	implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
	@WebSocketServer()
	server!: Server

	private clients: Set<WebSocket> = new Set()

	afterInit(server: Server) {
		logger.log("WebSocket server initialized")
	}

	handleDisconnect(client: any) {}

	async handleConnection(client: WebSocket) {
		const url = new URL(`https://localhost${client.url}`)
		const uuid = crypto.randomUUID()
		logger.log("Attempting to connect socket:", uuid, url.pathname)

		const access_token = url.searchParams.get("access_token")
		if (!access_token) {
			client.send(BuildWSMessage("status", "authentication failed", "red"))
			client.close(401)
			return
		}
		const payload = await OAuthUtils.verifyJWT(access_token, "system")
		if (!payload) {
			client.send(BuildWSMessage("status", "authentication failed", "red"))
			client.close(401)
			return
		}

		client.send(BuildWSMessage("status", "authentication complete!", "green"))
		client.send(BuildWSMessage("status", "checking authorization"))
		const is_authorized = await OAuthUtils.doesPermissionsMatch(
			payload,
			"global",
			10
		)
		if (!is_authorized) {
			client.send(BuildWSMessage("status", "authorization failed!", "red"))
			client.close(401)
			return
		}

		client.send(BuildWSMessage("status", `authorization complete!`, "green"))
		client.send(BuildWSMessage("status", `connection uuid: ${uuid}`))
		SOCKETS.add(client as any)
	}

	broadcast(message: string) {}
}
