import { applyDecorators, ExecutionContext, UseGuards } from "@nestjs/common"
import { ApiHeader, ApiParam } from "@nestjs/swagger"
import { NetworkGuard } from "./network.guard"
import { AuthorizationGuard, IAuthorizationConfig } from "./authorization.guard"
import { RELOAD_SYNCED_CONFIG, SYNCED_CONFIG } from "@common/utils"
import { permissionsTable } from "@schemas"
import { logger } from "@gezcez/core"
import { PermissionsRepository } from "@services/permissions/permissions.repository"
import { sleep } from "bun"

export function UseAuthorization<
	T extends boolean,
	SCOPE extends "global" | "scoped"
>(config: IAuthorizationConfig<T, SCOPE>) {
	const is_dev = process.env.NODE_ENV === "production" ? false : true
	const is_dev_string = is_dev ? "_dev" : ""
	if (!(config.app_key && config.permission_key && config.scope)) {
		throw new Error(
			"UseAuthorization decorator requires app_key, permission_key and scope"
		)
	}
	// console.log("permission check for", {
	// 	app: config.app_key,
	// 	key: config.permission_key,
	// 	scope: config.scope
	// })
	if (
		!SYNCED_CONFIG.permissions.find(
			(e) => config.permission_key === e.key && config.app_key === e.app
		)
	) {
		RELOAD_SYNCED_CONFIG().then(async (new_config) => {
			await sleep(1)
			if (
				!new_config.permissions.find(
					(e) => config.permission_key === e.key && config.app_key === e.app
				)
			) {
				logger.warning(
					`authorization.decorator.ts couldn't find permission with key '${config.app_key}/${config.permission_key}', creating one`
				)
				PermissionsRepository.createPermission(
					config.app_key,
					config.permission_key
				).catch((err) => {
					logger.error(
						`authorization.decorator.ts couldn't create permission with key '${config.app_key}/${config.permission_key}'`,
						err
					)
				})
			}
		})
	}
	const conditional_decorator =
		config.scope === "global" ? undefined : NetworkGuard
	const conditional_param =
		config.scope === "global"
			? undefined
			: ApiParam({
					name: "network_id",
					required: true,
					type: String,
					example: 1
				})
	return applyDecorators(
		UseGuards(
			...[
				conditional_decorator,
				AuthorizationGuard({
					...config,
					app_key: `${config.app_key}${is_dev_string}`
				} as any)
			].filter((e) => !!e)
		),
		ApiHeader({
			name: "Authorization",
			required: true,
			example: "Bearer ey..."
		}),
		...[conditional_param].filter((e) => !!e)
	)
}
