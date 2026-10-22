// jwt.types.ts
// Access token claims (plan section 6.1.3) and the request auth shape set by the authentication guard.

export type AuthMethod = "otp" | "pwd" | "webauthn"

export interface AccessTokenClaims {
	iss: string
	sub: string
	aud: string
	scope: string
	sid: string
	auth_time: number
	amr: AuthMethod[]
	iat: number
	exp: number
}

/** What `req.auth` holds after the authentication guard accepted a bearer token. */
export interface RequestAuth {
	userId: number
	publicId: string
	clientId: string
	scopes: string[]
	sid: string
	authTime: number
	amr: AuthMethod[]
	exp: number
}
