import {
	WebSocketGateway,
	OnGatewayConnection,
	WebSocketServer,
	OnGatewayDisconnect,
	OnGatewayInit,
} from "@nestjs/websockets"
import { Server, WebSocket } from "ws"
import { logger } from "../util"
import { OAuthService } from "../services/oauth/oauth.service"
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
		console.log("WebSocket server initialized")
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
		const payload = await OAuthService.verifyJWT(access_token, "system")
		if (!payload) {
			client.send(BuildWSMessage("status", "authentication failed", "red"))
			client.close(401)
			return
		}

		client.send(BuildWSMessage("status", "authentication complete!", "green"))
		client.send(BuildWSMessage("status", "checking authorization"))
		const is_authorized = await OAuthService.doesPermissionsMatch(
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
		SOCKETS.add(client)
	}

	broadcast(message: string) {}
}
