import {
	CanActivate,
	ExecutionContext,
	Injectable,
	NestMiddleware,
} from "@nestjs/common"
import { GezcezError, GezcezValidationFailedError } from "../common/GezcezError"
import { NextFunction, Request, Response } from "express"
import { OAuthService } from "../services/oauth/oauth.service"

export class NetworkMiddleware implements NestMiddleware {
	async use(req: Request, res: Response, next: NextFunction) {
		const p_network_id = req.params["network_id"]
		let network_id
		try {
			network_id = parseInt(p_network_id)
		} catch {
			return GezcezError("BAD_REQUEST", { __message: "Network geçersiz." })
		}
		if (network_id > 100 || network_id <= 0) {
			return GezcezError("BAD_REQUEST", { __message: "Network geçersiz." })
		}
		next()
	}
}
