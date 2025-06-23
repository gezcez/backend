import { and, eq, or } from "drizzle-orm"
import { usersTable } from "../../schema/users"
import { config, db } from "../../util"
import { password } from "bun"
import { JWTPayload, jwtVerify, SignJWT } from "jose"

export abstract class OAuthService {
	static validate(v_type: "username" | "email" | "password", value: string) {
		switch (v_type) {
			case "username": {
				if (value.length > config.validation[v_type].max_length || value.length < config.validation[v_type].min_length) {
					return false
				}
				if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9]|(?<!\.)[_.](?!\.)){1,18}[a-zA-Z0-9]$/.test(value)) {
					return false
				}
				if (value.includes(" ")) return false
				return true
			}
			case "email": {
				if (value.length > config.validation[v_type].max_length || value.length < config.validation[v_type].min_length) return false
				// just in case Elysia.t fails SOMEHOW
				if (value.includes("+")) return false
				if (!value.includes("@")) return false
				if (!value.includes(".")) return false
				return true
			}
			case "password": {
				if (value.length > config.validation[v_type].max_length || value.length < config.validation[v_type].min_length) return false
				return true
			}

			default: {
				return false
			}
		}
	}
	static async isUsernameOrEmailTaken(username: string, email: string) {
		const [result] = await db
			.select()
			.from(usersTable)
			.where(or(eq(usersTable.username, username), eq(usersTable.email, email)))
		if (result) return false
		return true
	}
	static async hashPassword(pwd: string) {
		return await password.hash(pwd, {
			algorithm: "bcrypt",
			cost: 14,
		})
	}
	static async signJWT(payload: JWTPayload, expiration: string, audience: string) {
		console.log(process.env.JWT_SECRET)
		return await new SignJWT(payload)
			.setProtectedHeader({
				alg: "HS256",
			})
			.setIssuer("oauth.gezcez.com")
			.setAudience(audience)
			.setExpirationTime(expiration)
			.sign(secret)
	}
	static async verifyJWT<T extends string>(token: string, audience: T) {
		const { payload }: { payload: GezcezJWTPayload<T> } = await jwtVerify(token, secret, {
			issuer: "oauth.gezcez.com",
			audience: audience,
		})
		
		return { ...payload}
	}
	static async getPermissionsFromPayload<T>(payload: GezcezJWTPayload<T>,network:string) {
		let user_scopes = payload.scopes
		const scope_number = user_scopes.get(network)
		if (!scope_number) return []
		const scopes_to_return = []
		let scope = scope_number
		for (let index = 32; index > 0; index--) {
			console.log(index, index ** 2)
			if (scope > index ** 2) {
				scope = scope - index ** 2
				scopes_to_return.push(index)
			}
		}
		return scopes_to_return
	}
}
interface GezcezJWTPayload<T> extends JWTPayload {
	scopes: Map<string,number>
	is_activated: boolean
}
const secret = new TextEncoder().encode(process.env.JWT_SECRET)
