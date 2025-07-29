import {
	CanActivate,
	ExecutionContext
} from "@nestjs/common"
import { GezcezError } from "../GezcezError" 

export class NetworkGuard implements CanActivate {
	async canActivate(context:ExecutionContext) {
		const req = context.switchToHttp().getRequest()
		const p_network_id = req.params["network_id"]
		let network_id
		try {
			network_id = parseInt(p_network_id)
			if (isNaN(network_id)) throw GezcezError("BAD_REQUEST", { __message: "Network geçersiz." })
		} catch {
			throw GezcezError("BAD_REQUEST", { __message: "Network geçersiz." })
		}
		if (network_id > 100 || network_id <= 0) {
			throw GezcezError("BAD_REQUEST", { __message: "Network geçersiz." })
		}
		req["network_id"] = network_id
		return true
	}
}
