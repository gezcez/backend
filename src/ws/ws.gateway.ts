import {
	WebSocketGateway,
	OnGatewayConnection,
	WebSocketServer,
} from "@nestjs/websockets"
import { Server, WebSocket } from "ws"

@WebSocketGateway()
export class WsGateway implements OnGatewayConnection {
	@WebSocketServer()
	server!: Server

	private clients: Set<WebSocket> = new Set()

	handleConnection(client: WebSocket) {
		this.clients.add(client)
		client.on("close", () => this.clients.delete(client))
	}

	broadcast(message: string) {
		this.clients.forEach((client) => {
			client.send(JSON.stringify({ type: "message", content: message }))
		})
	}
}
