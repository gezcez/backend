import Elysia, { t } from "elysia"
import { GezcezResponse } from "../common/Gezcez"
import { NetworkService } from "../services/network/network.service"

export const NetworkMiddleware = new Elysia({name: "network.middleware.ts" })
	.guard({
		params: t.Object({ network_id: t.Integer() }),
	})
	.resolve({ as: "scoped" }, async ({ params }) => {
		const network = await NetworkService.getNetworkById(params.network_id)
		return { network: network }
	})
	.guard({
		beforeHandle({ network, params, set }) {
			if (!network) {
				set.status = 400
				return GezcezResponse({ __message: `Network '${params.network_id}' is invalid` }, 400)
			}
		},
	})
