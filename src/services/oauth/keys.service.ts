// keys.service.ts
// ES256 signing keys: generation, sealed storage, JWKS, signing and verification of access
// tokens (plan section 6.1.5). One active key plus the previous ones until they retire.

import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"
import {
	createLocalJWKSet,
	errors as joseErrors,
	exportJWK,
	generateKeyPair,
	importJWK,
	jwtVerify,
	SignJWT,
	type JSONWebKeySet,
	type JWK,
	type CryptoKey,
} from "jose"
import { InjectConfig, type AppConfig } from "@common/config"
import { GezcezError } from "@common/errors"
import type { AccessTokenClaims } from "@common/jwt.types"
import { newId, seal, unseal } from "@common/utils"
import { SystemService } from "@services/system/system.service"
import { KeysRepository, type SigningKeyRow } from "./keys.repository"

const SEAL_PURPOSE = "signing-key"
const ACTIVATION_DELAY_MS = 24 * 3600_000
const RETIREMENT_DELAY_MS = 30 * 24 * 3600_000
const RELOAD_INTERVAL_MS = 5 * 60_000

export type AccessTokenInput = Omit<AccessTokenClaims, "iss" | "iat" | "exp">

interface LoadedKeys {
	loadedAt: number
	active?: { kid: string; key: CryptoKey }
	jwks: JSONWebKeySet
	verifier: ReturnType<typeof createLocalJWKSet>
}

@Injectable()
export class KeysService implements OnModuleInit {
	private readonly logger = new Logger("Keys")
	private loaded?: LoadedKeys

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly repository: KeysRepository,
		private readonly system: SystemService,
	) {}

	async onModuleInit(): Promise<void> {
		await this.ensureKey()
		this.system.registerProbe(() => ({ name: "signing_key", ok: Boolean(this.loaded?.active) }))
	}

	/** Creates the first key on an empty database (active immediately). */
	async ensureKey(now = new Date()): Promise<void> {
		const keys = this.repository.listUnretired(now)
		if (!keys.some((key) => key.active_from <= now)) {
			await this.createKey(now)
			this.logger.log("Generated the first signing key")
		}
		await this.reload(now)
	}

	/**
	 * Adds a key that becomes active after 24 h (so cached JWKS pick it up first) and schedules
	 * the currently active keys to retire 30 days later.
	 */
	async rotate(
		now = new Date(),
		activationDelayMs = ACTIVATION_DELAY_MS,
	): Promise<{ kid: string }> {
		const current = this.repository.listUnretired(now).filter((key) => !key.retire_after)
		const kid = await this.createKey(new Date(now.getTime() + activationDelayMs), now)
		for (const key of current) {
			this.repository.scheduleRetirement(
				key.kid,
				new Date(now.getTime() + activationDelayMs + RETIREMENT_DELAY_MS),
			)
		}
		await this.reload(now)
		return { kid }
	}

	jwks(): JSONWebKeySet {
		return this.loaded?.jwks ?? { keys: [] }
	}

	async sign(input: AccessTokenInput, ttlSeconds: number, now = new Date()): Promise<string> {
		const keys = await this.current(now)
		if (!keys.active) throw new GezcezError("INTERNAL", "No active signing key")
		const iat = Math.floor(now.getTime() / 1000)
		return new SignJWT({ ...input })
			.setProtectedHeader({ alg: "ES256", kid: keys.active.kid, typ: "at+jwt" })
			.setIssuer(this.config.issuer)
			.setIssuedAt(iat)
			.setExpirationTime(iat + ttlSeconds)
			.sign(keys.active.key)
	}

	/** Verifies signature, issuer and expiry. Throws AUTH_TOKEN_EXPIRED or AUTH_TOKEN_INVALID. */
	async verify(token: string, now = new Date()): Promise<AccessTokenClaims> {
		const keys = await this.current(now)
		try {
			const { payload } = await jwtVerify(token, keys.verifier, {
				issuer: this.config.issuer,
				algorithms: ["ES256"],
				typ: "at+jwt",
				currentDate: now,
				requiredClaims: ["sub", "aud", "sid", "exp", "iat", "auth_time"],
			})
			if (typeof payload.aud !== "string") throw new GezcezError("AUTH_TOKEN_INVALID")
			return payload as unknown as AccessTokenClaims
		} catch (error) {
			if (error instanceof GezcezError) throw error
			if (error instanceof joseErrors.JWTExpired) throw new GezcezError("AUTH_TOKEN_EXPIRED")
			throw new GezcezError("AUTH_TOKEN_INVALID")
		}
	}

	private async current(now: Date): Promise<LoadedKeys> {
		if (!this.loaded || now.getTime() - this.loaded.loadedAt > RELOAD_INTERVAL_MS)
			await this.reload(now)
		// A key scheduled for later may have become active since the last load.
		const pending = this.loaded?.active === undefined
		if (pending) await this.reload(now)
		return this.loaded!
	}

	private async reload(now: Date): Promise<void> {
		const rows = this.repository.listUnretired(now)
		const activeRow = [...rows].reverse().find((row) => row.active_from <= now)
		const jwks: JSONWebKeySet = {
			keys: rows.map((row) => ({
				...(row.public_jwk as JWK),
				kid: row.kid,
				alg: "ES256",
				use: "sig",
			})),
		}
		this.loaded = {
			loadedAt: now.getTime(),
			jwks,
			verifier: createLocalJWKSet(jwks),
			active: activeRow
				? { kid: activeRow.kid, key: await this.privateKey(activeRow) }
				: undefined,
		}
	}

	private async privateKey(row: SigningKeyRow): Promise<CryptoKey> {
		const jwk = JSON.parse(
			unseal(this.config.secrets.keyEncryption, SEAL_PURPOSE, row.private_jwk_enc),
		) as JWK
		return (await importJWK(jwk, "ES256")) as CryptoKey
	}

	private async createKey(activeFrom: Date, now = activeFrom): Promise<string> {
		const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true })
		const kid = newId()
		const publicJwk = await exportJWK(publicKey)
		const privateJwk = await exportJWK(privateKey)
		this.repository.insert({
			kid,
			alg: "ES256",
			public_jwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
			private_jwk_enc: seal(
				this.config.secrets.keyEncryption,
				SEAL_PURPOSE,
				JSON.stringify(privateJwk),
			),
			created_at: now,
			active_from: activeFrom,
			retire_after: null,
		})
		return kid
	}
}
