import { ConfigurableModuleBuilder, INestApplication, Type } from "@nestjs/common"
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from "@nestjs/common/constants"
import "reflect-metadata"
import { RELOAD_SYNCED_CONFIG, SYNCED_CONFIG } from "./master"

import { logger } from "../../../../core/src/util/logger"
import { permissionPathRegistryTable, permissionsTable } from "@schemas"
interface IArgs {
	config: {
		app_key: string
		sudo_mode: boolean
		permission_key: string
		scope: "global" | "scoped"
		description?: string
	}
	path: string
	method: string
}
export async function handlePermissionRegistryAndReturnID(args: IArgs) {
	const { path, config } = args
	let found_permission = SYNCED_CONFIG.permissions.find(
		(e) => e.key === config.permission_key && e.app === config.app_key
	)
	if (!found_permission) {
		found_permission = await createPermissionFromScratch(args)
	}
	if (!found_permission) {
		throw new Error("permission registry failed TWICE")
	}
	let registry = SYNCED_CONFIG.path_registries.find(
		(e) => e.path === args.path && e.method === args.method && found_permission?.id === e.permission_id
	)
	if (!registry) {
		registry = await upsertPathRegistry({ ...args, permission: found_permission })
	}
	if (!registry) {
		throw new Error("path registry failed TWICE")
	}
	return found_permission?.id
}
async function upsertPathRegistry(args: IArgs & { permission: typeof permissionsTable.$inferSelect }) {
	const matrix_results = await SYNCED_CONFIG.__DANGEROURS_ACCESS_DB
		?.insert(permissionPathRegistryTable)
		.values({
			path: args.path,
			method: args.method,
			sudo_mode: args.config.sudo_mode,
			description: args.config.description,
			permission_id: args.permission?.id,
			type: args.config.scope,
		})
		.onConflictDoUpdate({
			target: [permissionPathRegistryTable.path, permissionPathRegistryTable.method],
			set: {
				updated_at: new Date(),
				description: args.config.description,
				type: args.config.scope,
				path: args.path,
				permission_id: args.permission?.id,
				sudo_mode: args.config.sudo_mode,
			},
		})
		.returning()
	const inserted_matrix = matrix_results && matrix_results[0]
	logger.success(`upserted pathpermission ${args.path} / ${args.method}`, JSON.stringify(inserted_matrix))
	await RELOAD_SYNCED_CONFIG({ db: SYNCED_CONFIG.__DANGEROURS_ACCESS_DB! })
	return inserted_matrix
}
async function createPermissionFromScratch(args: IArgs) {
	const results = await SYNCED_CONFIG.__DANGEROURS_ACCESS_DB
		?.insert(permissionsTable)
		.values({
			app: args.config.app_key,
			key: args.config.permission_key,
		})
		.onConflictDoNothing()
		.returning()
	const inserted_permission = results && results[0]

	logger.success(
		`upserted permission ${args.config.app_key} / ${args.config.permission_key}`,
		JSON.stringify(args)
	)
	await RELOAD_SYNCED_CONFIG({ db: SYNCED_CONFIG.__DANGEROURS_ACCESS_DB! })

	return inserted_permission
}
