import { GezcezJWTPayload } from "../services/oauth/oauth.service"
declare global {
	interface Request {
		payload: GezcezJWTPayload
		network_id: number
	}
}
export {}
