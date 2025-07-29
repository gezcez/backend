import { jwtVerify, SignJWT } from "jose"
import { IConfig } from "../types/config"
import { GezcezJWTPayload } from "../types/gezcez"
import { buildConfig } from "./config"
import { RoleUtils } from "./role.utils"
import { SYNCED_CONFIG } from "./master"
const config = buildConfig()
export abstract class OAuthUtils {
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
	static async hashPassword(pwd: string) {
		return await Bun.password.hash(pwd, {
			algorithm: "bcrypt",
			cost: 14,
		})
	}

	static async doesPermissionsMatch(
		payload: GezcezJWTPayload,
		network: "global" | (number),
		permission_id: number
	) {
		const user_permissions = this.getPermissionIDsFromPayload(
			payload,
			network === "global" ? "_" : `${network}`
		)
		const user_roles = RoleUtils.getRolesFromValue(
			payload.roles[network === "global" ? "_" : `${network}`]
		)
		console.log(`user ${payload.sub} roles`,user_roles.map((e)=>e.id).join(","))
		const role_permissions = user_roles.map((role)=>SYNCED_CONFIG.role_permissions.filter((p)=>p.role_id===role.id)).reduce((a,b)=>[...a,...b],[])
		console.log(`search: ${permission_id}`,"role permissions:",role_permissions.map((e)=>e.permission_id).join(","))
		if ([...user_permissions,...role_permissions.map((e)=>e.permission_id)].includes(permission_id)) return true
		return false
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
	static getPermissionIDsFromPayload(payload: GezcezJWTPayload, network: string) {
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
}
export const secret = new TextEncoder().encode(process.env.JWT_SECRET)
export const secret_random = new TextEncoder().encode(
	process.env.JWT_RANDOM_STUFF
)

export async function isTokenInvalid(payload:GezcezJWTPayload) {
	const id = payload.jti
	const parent_id = payload.parent
	if (!id) return true
	let is_invalid_due_to_id = SYNCED_CONFIG.invalid_tokens.find((e)=>e===id)
	let is_invalid_due_to_parent_id
	if (parent_id) {
		is_invalid_due_to_parent_id = SYNCED_CONFIG.invalid_tokens.find((e)=>e===parent_id)
	}
	return is_invalid_due_to_id ||is_invalid_due_to_parent_id
}