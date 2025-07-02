import { and, eq, or } from "drizzle-orm"
import { usersTable } from "../../schema/users"
import { config, db } from "../../util"
import { password } from "bun"
import { JWTPayload, jwtVerify, SignJWT } from "jose"
import { userPermissionsTable } from "../../schema/permissions"

export abstract class OAuthService {
	static validate(v_type: "username" | "email" | "password", value: string) {
		switch (v_type) {
			case "username": {
				if (
					value.length > config.validation[v_type].max_length ||
					value.length < config.validation[v_type].min_length
				) {
					return false
				}
				if (
					!/^[a-zA-Z0-9](?:[a-zA-Z0-9]|(?<!\.)[_.](?!\.)){1,18}[a-zA-Z0-9]$/.test(value)
				) {
					return false
				}
				if (value.includes(" ")) return false
				return true
			}
			case "email": {
				if (
					value.length > config.validation[v_type].max_length ||
					value.length < config.validation[v_type].min_length
				)
					return false
				// just in case Elysia.t fails SOMEHOW
				if (value.includes("+")) return false
				if (!value.includes("@")) return false
				if (!value.includes(".")) return false
				return true
			}
			case "password": {
				if (
					value.length > config.validation[v_type].max_length ||
					value.length < config.validation[v_type].min_length
				)
					return false
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
	static async signJWT(
		payload: Omit<GezcezJWTPayload, "scopes">,
		expiration: string,
		audience: string
	) {
		return await new SignJWT({ jti: crypto.randomUUID(), ...payload })
			.setProtectedHeader({
				alg: "HS256",
			})
			.setIssuer("oauth.gezcez.com")
			.setAudience(audience)
			.setExpirationTime(expiration)
			.sign(secret)
	}
	static async verifyJWT(token: string, audience: string) {
		let payload
		try {
			payload = (
				await jwtVerify(token, secret, {
					issuer: "oauth.gezcez.com",
					audience: audience,
				})
			).payload
		} catch {}
		if (!payload) return

		return {
			...payload,
			sub: parseInt(payload?.sub as string) as number,
		} as GezcezJWTPayload
	}
	static getPermissionIDsFromPayload(
		payload: GezcezJWTPayload,
		network: string
	) {
		let user_scopes = payload.scopes || {}
		const scope_number = user_scopes[network as keyof typeof user_scopes]
		if (!scope_number) return []
		const scopes_to_return = []
		let scope = scope_number
		for (let index = 32; index > 0; index--) {
			if (scope >= 2 ** index) {
				scope = scope - 2 ** index
				scopes_to_return.push(index)
			}
		}
		return scopes_to_return
	}
	static async listUserPermissionsOnGlobalScope(user_id: number) {}
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
	static async doesPermissionsMatch(
		payload: GezcezJWTPayload,
		network: "global" | (string & {}),
		permission_id: number
	) {
		const user_permissions = OAuthService.getPermissionIDsFromPayload(
			payload,
			network === "global" ? "_" : network
		)
		if (user_permissions.includes(permission_id)) return true
		return false
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
export type GezcezJWTPayload = {
	jti: string
	sub: number
	scopes: { [key: string]: number }
	is_activated: boolean
} & Omit<JWTPayload, "sub">



export const secret = new TextEncoder().encode(process.env.JWT_SECRET)
export const secret_random = new TextEncoder().encode(
	process.env.JWT_RANDOM_STUFF
)
