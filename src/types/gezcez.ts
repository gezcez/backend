import { JWTPayload } from "jose"

export type GezcezJWTPayload = {
	jti: string
	sub: number
	scopes: { [key: string]: number }
	roles: {[key:string]:number}
	is_activated: boolean
} & Omit<JWTPayload, "sub">