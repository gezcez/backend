import { and, eq } from "drizzle-orm"
import { usersTable } from "../../schema/users"
import { db } from "../../util"
import { OAuthService } from "./oauth.service"

export abstract class OAuthRepository {
	
	static async insertUser(user: typeof usersTable.$inferInsert): Promise<[typeof usersTable.$inferSelect] | [false, string]> {
		const is_username_and_email_available = await OAuthService.isUsernameOrEmailTaken(user.username, user.email)
		if (!is_username_and_email_available) return [false, "username or email is already in use"]
		const [result] = await db.insert(usersTable).values({
			...user,
			password: await OAuthService.hashPassword(user.password)
		}).returning()
		return [result]
	}

	static async selectUserById(user_id: number) {
		const [result] = await db.select({
			user: {
				...usersTable,
				password: "",
				email: "",
			}
		}).from(usersTable).where(
			eq(usersTable.id, user_id)
		).limit(1)
	}
	static async selectUserByEmailAndPassword(email: string, password: string) {
		const hashed_password = await OAuthService.hashPassword(password)
		const [result] = await db.select({
			user: {
				...usersTable,
				password: "",
			}
		}).from(usersTable).where(
			and(eq(usersTable.email, email), eq(usersTable.password, password))
		).limit(1)
		return result
	}
}