import { GezcezJWTPayload } from "./gezcez"
import type {Request} from "express"
export interface GezcezRequest extends Request {
	payload: GezcezJWTPayload
	network_id: number
}

declare global {
	namespace Express {
		interface Request {
			payload: GezcezJWTPayload
			network_id: number
		}
	}
}
export {}
