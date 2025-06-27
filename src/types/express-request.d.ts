import { GezcezJWTPayload } from "../services/oauth/oauth.service"
declare global {
	namespace Express {
		interface Request {
			payload?: GezcezJWTPayload
			network_id?: string
		}
	}
}
export {}
