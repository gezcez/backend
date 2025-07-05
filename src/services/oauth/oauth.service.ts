import { and, eq, or } from "drizzle-orm"
import { userPermissionsTable, usersTable } from "../../schemas"
import { db } from "../../db"


export abstract class OAuthService {
	
	static async isUsernameOrEmailTaken(username: string, email: string) {
		const [result] = await db
			.select()
			.from(usersTable)
			.where(or(eq(usersTable.username, username), eq(usersTable.email, email)))
		if (result) return false
		return true
	}
	
	static async listUserPermissionsWithNetworkId(
		user_id: number,
		network_id: number
	) {
		const results = await db
			.select()
			.from(userPermissionsTable)
			.where(
				and(
					eq(userPermissionsTable.status, true),
					eq(userPermissionsTable.user_id, user_id),
					eq(userPermissionsTable.network_id, network_id)
				)
			)
		return results
	}

	static async activateUser(user_id: number) {
		const [result] = await db
			.update(usersTable)
			.set({ activated_at: new Date() })
			.where(eq(usersTable.id, user_id))
			.returning()
		return result
	}
}


