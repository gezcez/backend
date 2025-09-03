import type { userRolesTable } from "@gezcez/backend"
import { SYNCED_CONFIG } from "./master"

export abstract class RoleUtils {
	static calculateRoleValueFromRoleIDs(ids:number[]) {
		let counter = 0
		for (const id of ids) {
			counter += 2**id
		}
		return counter
	}
	static async getPermissionIDsFromRole(role_id:number) {

	}
	static getRolesFromValue(value:number) {
		if (!value) value = 0
		const roles = SYNCED_CONFIG.roles
		const roles_sorted = roles.sort((a,b)=>b.id-a.id)
		console.log("roles_sorted",roles_sorted)
		const found_roles = []
		let current_value = value
		for (const role of roles_sorted) {
			if (current_value >= 2**role.id) {
				current_value -= 2**role.id
				found_roles.push(role)
			}
		}
		return found_roles
	}
	static getValueFromRoles(roles:typeof userRolesTable.$inferSelect[]) {
		let counter = 0
		for (const role of roles) {
			counter+= 2**(role.role_id)
		}
		console.log("value: ",counter,"roles:",roles.map((e)=>e.id))
		return counter
	}
	
}