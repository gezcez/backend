import { applyDecorators, ExecutionContext, UseGuards } from "@nestjs/common"
import { ApiHeader, ApiParam } from "@nestjs/swagger"
import { NetworkGuard } from "./network.guard"
import { GezcezJWTPayload } from "../../types"
import { AuthorizationGuard, IAuthorizationConfig } from "./authorization.guard"

export function UseAuthorization<T extends boolean, SCOPE extends "global" | "scoped">(
	config: IAuthorizationConfig<T, SCOPE>
) {
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
