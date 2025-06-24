import Elysia, { t } from "elysia"
import { GezcezResponse } from "../common/Gezcez"
import { NetworkService } from "../services/network/network.service"
import { NetworkRepository } from "../services/network/network.repository"
import { networksTable } from "../schema/networks"

export const NetworkMiddleware = <T extends "global" | "scoped">(config?: {
	scope: T
}) =>
	new Elysia({
		name: "network.middleware.ts",
		prefix: config?.scope === "global" ? "" : "/:network_id",
	})
		.guard({
			params:config?.scope === "global" ? t.Undefined() : t.Object({
				network_id: t.Integer()
			}),
		})
		.resolve(async ({ params }) => {
			const network_id = params?.network_id
			if (config?.scope === "scoped" && network_id) {
				const network = await NetworkRepository.getNetworkById(network_id)
				return { network: network }
			}
		})
		.guard({
			beforeHandle({ network, params, set }) {
				if (!network && config?.scope !== "global") {
					set.status = 400
					return GezcezResponse(
						{ __message: `Network '${params?.network_id}' is invalid` },
						400
					)
				}
			},
		})
