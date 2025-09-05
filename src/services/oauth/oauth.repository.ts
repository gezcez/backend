import { and, eq, or } from "drizzle-orm"
import { OAuthService } from "./oauth.service"
import { password as Password } from "bun"
import { db } from "../../db"
import { refreshTokensTable, sudosTable, usersTable } from "@schemas"
import { OAuthUtils } from "@common/utils"
export abstract class OAuthRepository {
	static async insertUser(
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
				password: await OAuthUtils.hashPassword(user.password)
			})
			.returning()
		return [result]
	}
	static async insertRefreshToken(user_id: number, jti: string) {
		const [result] = await db
			.insert(refreshTokensTable)
			.values({
				created_by: user_id,
				id: jti,
				args: { type: "oauth" }
			})
			.returning()
		return result
	}
	static async getSudoRow(sudo_key: string, payload_sub: number) {
		const [sudo_row] = await db
			.select()
			.from(sudosTable)
			.where(
				and(
					eq(sudosTable.sudo_key, sudo_key),
					eq(sudosTable.created_by, payload_sub)
				)
			)
			.limit(1)
		return sudo_row
	}

	static async getRefreshTokenById(linked_refresh_token_id: string, user_id: number) {
		const [refresh_token] = await db
			.select()
			.from(refreshTokensTable)
			.where(
				and(
					eq(refreshTokensTable.id, linked_refresh_token_id),
					eq(refreshTokensTable.created_by, user_id)
				)
			)
			.limit(1)
		return refresh_token
	}
	static async getUserById(
		user_id: number | string,
		config?: { get_raw_password?: boolean; get_raw_email?: boolean }
	) {
		if (typeof user_id === "string") user_id = parseInt(user_id)
		const [result] = await db
			.select()
			.from(usersTable)
			.where(eq(usersTable.id, user_id))
			.limit(1)
		return {
			...result,
			password: config?.get_raw_password ? result.password : undefined,
			email: config?.get_raw_email ? result.email : undefined
		}
	}
	static async getUserByEmailAndPassword(email: string, password: string) {
		const [result] = await db
			.select()
			.from(usersTable)
			.where(eq(usersTable.email, email))
			.limit(1)
		if (!result) return
		const is_verified = await Password.verify(
			password,
			result?.password,
			"bcrypt"
		)
		if (is_verified) return { ...result, password: undefined }
	}

	static async getUserByUsernameAndEmail(email: string, username: string) {
		const [result] = await db
			.select()
			.from(usersTable)
			.where(or(eq(usersTable.username, username), eq(usersTable.email, email)))
		return result
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
