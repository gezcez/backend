import { and, eq } from "drizzle-orm"
import { usersTable } from "../../schema/users"
import { db } from "../../util"
import { OAuthService } from "./oauth.service"
import { password as Password } from "bun"
export abstract class OAuthRepository {
	static async insert(
		user: typeof usersTable.$inferInsert
	): Promise<[typeof usersTable.$inferSelect] | [false, string]> {
		const is_username_and_email_available =
			await OAuthService.isUsernameOrEmailTaken(user.username, user.email)
		if (!is_username_and_email_available)
			return [false, "username or email is already in use"]
		const [result] = await db
			.insert(usersTable)
			.values({
				...user,
				password: await OAuthService.hashPassword(user.password),
			})
			.returning()
		return [result]
	}

	static async selectUserById(
		user_id: number,
		config?: { get_raw_password?: boolean; get_raw_email?: boolean }
	) {
		const [result] = await db
			.select()
			.from(usersTable)
			.where(eq(usersTable.id, user_id))
			.limit(1)
		return {
			...result,
			password: config?.get_raw_password ? result.password : undefined,
			email: config?.get_raw_email ? result.email : undefined,
		}
	}
	static async selectUserByEmailAndPassword(email: string, password: string) {
		const [result] = await db
			.select()
			.from(usersTable)
			.where(eq(usersTable.email, email))
			.limit(1)
		const is_verified = await Password.verify(password, result.password, "bcrypt")
		if (is_verified) return { ...result, password: undefined }
	}
}
