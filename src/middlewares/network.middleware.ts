import Elysia, { t } from "elysia"
import { GezcezResponse } from "../common/Gezcez"
import { NetworkService } from "../services/network/network.service"
import { NetworkRepository } from "../services/network/network.repository"

export const NetworkMiddleware = new Elysia({
	name: "network.middleware.ts",
	prefix: "/:network_id",
})
	.guard({
		as: "scoped",
		params: t.Object({
			network_id: t.Integer({ minimum: 1, maximum: 999 }),
		}),
	})
	.resolve({ as: "scoped" }, async ({ params: { network_id } }) => {
		const network = await NetworkRepository.getNetworkById(parseInt(network_id))
		return { network: network }
	})
	.guard({
		as: "scoped",
		beforeHandle({ network, params, set }) {
			if (!network) {
				set.status = 400
				return GezcezResponse({ __message: `Network '${params.network_id}' is invalid` }, 400)
			}
		},
	})
