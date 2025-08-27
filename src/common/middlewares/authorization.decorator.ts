import { applyDecorators, ExecutionContext, UseGuards } from "@nestjs/common"
import { ApiHeader, ApiParam } from "@nestjs/swagger"
import { NetworkGuard } from "./network.guard"
import { GezcezJWTPayload } from "../../types"
import { AuthorizationGuard, IAuthorizationConfig } from "./authorization.guard"
import { logger, RELOAD_SYNCED_CONFIG, SYNCED_CONFIG } from "@common/utils"
import { db } from "@db"
import { permissionsTable } from "@schemas"

export function UseAuthorization<T extends boolean, SCOPE extends "global" | "scoped">(
	config: IAuthorizationConfig<T, SCOPE>
) {
	if (!SYNCED_CONFIG.permissions.find((e)=>config.permission_key===e.key&&config.app_key===e.app)) {
		RELOAD_SYNCED_CONFIG({db:db}).then(()=>{
			if (!SYNCED_CONFIG.permissions.find((e)=>config.permission_key===e.key&&config.app_key===e.app)) {
				logger.warning(`authorization.decorator.ts could'nt find permission with key '${config.app_key}/${config.permission_key}', creating one`)
				db.insert(permissionsTable).values({
					app:config.app_key,
					key:config.permission_key
				}).then((e)=>{
					logger.success(`Created permission '${config.app_key}/${config.permission_key}'`)
				})
			}
		})
	}
	const conditional_decorator = config.scope === "global" ? undefined : NetworkGuard
	const conditional_param =
		config.scope === "global"
			? undefined
			: ApiParam({ name: "network_id", required: true, type: String, example: 1 })
	return applyDecorators(
		UseGuards(...[conditional_decorator, AuthorizationGuard(config as any)].filter((e) => !!e)),
		ApiHeader({ name: "Authorization", required: true, example: "Bearer ey..." }),
		...[conditional_param].filter((e)=>!!e)
	)
}
