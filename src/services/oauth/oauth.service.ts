import { and, eq, or } from "drizzle-orm"
import { usersTable } from "../../schema/users"
import { config, db } from "../../util"
import { password } from "bun"

export abstract class OAuthService {
	static validate(v_type: "username" | "email" | "password", value: string) {
		switch (v_type) {
			case "username": {
				if (value.length > config.validation[v_type].max_length
					|| value.length < config.validation[v_type].min_length) {
					return false
				}
				if (!(/^[a-zA-Z0-9](?:[a-zA-Z0-9]|(?<!\.)[_.](?!\.)){1,18}[a-zA-Z0-9]$/).test(value)) {
					return false
				}
				if (value.includes(" ")) return false
				return true
			} case "email": {
				if (value.length > config.validation[v_type].max_length || value.length < config.validation[v_type].min_length) return false
				// just in case Elysia.t fails SOMEHOW
				if (value.includes("+")) return false
				if (!value.includes("@")) return false
				if (!value.includes(".")) return false
				return true
			} case "password": {
				if (value.length > config.validation[v_type].max_length || value.length < config.validation[v_type].min_length) return false
				return true
			}

			default: {
				return false
			}
		}
	}
	static async isUsernameOrEmailTaken(username: string, email: string) {
		const [result] = await db.select().from(usersTable).where(or(
			eq(usersTable.username, username),
			eq(usersTable.email, email)
		))
		if (result) return false
		return true
	}
	static async hashPassword(pwd: string) {
		return await password.hash(pwd, {
			algorithm: "bcrypt", cost: 14
		})
	}
}