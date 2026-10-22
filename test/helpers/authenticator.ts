// test/helpers/authenticator.ts
// A software WebAuthn authenticator: ES256 (P-256) credentials, "none" attestation, a sign
// counter per credential, and discoverable credentials that return the user handle. It builds
// the same RegistrationResponseJSON / AuthenticationResponseJSON a browser hands the oauth UI.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto"
import { isoCBOR } from "@simplewebauthn/server/helpers"

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_BE = 0x08
const FLAG_BS = 0x10
const FLAG_AT = 0x40

export interface SoftCredential {
	id: string
	privateKey: KeyObject
	cose: Uint8Array
	rpId: string
	userHandle: string
	counter: number
}

interface CreationOptions {
	challenge: string
	rp: { id?: string; name: string }
	user: { id: string; name: string; displayName: string }
	excludeCredentials?: { id: string }[]
}

interface RequestOptions {
	challenge: string
	rpId?: string
	allowCredentials?: { id: string }[]
}

const b64 = (value: Uint8Array | Buffer | string) => Buffer.from(value).toString("base64url")
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest()

function counterBytes(counter: number): Buffer {
	const out = Buffer.alloc(4)
	out.writeUInt32BE(counter)
	return out
}

export class SoftAuthenticator {
	readonly credentials: SoftCredential[] = []

	constructor(
		/** The page origin the "browser" reports in clientDataJSON. */
		public origin: string,
		private readonly options: { userVerified?: boolean; backedUp?: boolean } = {},
	) {}

	private flags(extra: number): number {
		let flags = FLAG_UP | extra
		if (this.options.userVerified ?? true) flags |= FLAG_UV
		if (this.options.backedUp) flags |= FLAG_BE | FLAG_BS
		return flags
	}

	private clientData(type: string, challenge: string, origin = this.origin): Buffer {
		return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
	}

	/** navigator.credentials.create() */
	create(
		options: CreationOptions,
		overrides: {
			rpId?: string
			origin?: string
			/** Re-attest an existing credential (a client that ignores excludeCredentials). */
			reuse?: SoftCredential
		} = {},
	) {
		const rpId = overrides.rpId ?? options.rp.id ?? new URL(this.origin).hostname
		const excluded = new Set(options.excludeCredentials?.map((c) => c.id) ?? [])
		if (
			!overrides.reuse &&
			this.credentials.some((c) => excluded.has(c.id) && c.rpId === rpId)
		)
			throw new Error("InvalidStateError: credential already registered")
		const credential = overrides.reuse ?? this.newCredential(rpId, options.user.id)
		const rawId = Buffer.from(credential.id, "base64url")
		const cose = credential.cose
		const lengthBytes = Buffer.alloc(2)
		lengthBytes.writeUInt16BE(rawId.length)
		const authData = Buffer.concat([
			sha256(rpId),
			Buffer.from([this.flags(FLAG_AT)]),
			counterBytes(0),
			Buffer.alloc(16), // aaguid
			lengthBytes,
			rawId,
			Buffer.from(cose),
		])
		const attestationObject = isoCBOR.encode(
			new Map<string, string | Map<string, never> | Uint8Array>([
				["fmt", "none"],
				["attStmt", new Map()],
				["authData", new Uint8Array(authData)],
			]),
		)
		if (!overrides.reuse) this.credentials.push(credential)
		return {
			credential,
			response: {
				id: credential.id,
				rawId: credential.id,
				type: "public-key" as const,
				response: {
					clientDataJSON: b64(
						this.clientData("webauthn.create", options.challenge, overrides.origin),
					),
					attestationObject: b64(attestationObject),
					transports: ["internal", "hybrid"],
				},
				authenticatorAttachment: "platform" as const,
				clientExtensionResults: {},
			},
		}
	}

	private newCredential(rpId: string, userHandle: string): SoftCredential {
		const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
		const jwk = publicKey.export({ format: "jwk" })
		const cose = isoCBOR.encode(
			new Map<number, number | Uint8Array>([
				[1, 2], // kty: EC2
				[3, -7], // alg: ES256
				[-1, 1], // crv: P-256
				[-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
				[-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
			]),
		)
		return { id: b64(randomBytes(32)), privateKey, cose, rpId, userHandle, counter: 0 }
	}

	/** navigator.credentials.get() */
	get(
		options: RequestOptions,
		overrides: {
			credential?: SoftCredential
			origin?: string
			rpId?: string
			counter?: number
			signWith?: KeyObject
			userHandle?: string | null
		} = {},
	) {
		const rpId = overrides.rpId ?? options.rpId ?? new URL(this.origin).hostname
		const allowed = options.allowCredentials?.map((c) => c.id)
		const credential =
			overrides.credential ??
			this.credentials.find(
				(c) => c.rpId === rpId && (!allowed?.length || allowed.includes(c.id)),
			)
		if (!credential) throw new Error("NotAllowedError: no credential for this RP")
		credential.counter = overrides.counter ?? credential.counter + 1
		const authData = Buffer.concat([
			sha256(rpId),
			Buffer.from([this.flags(0)]),
			counterBytes(credential.counter),
		])
		const clientDataJSON = this.clientData("webauthn.get", options.challenge, overrides.origin)
		const signature = sign(
			"sha256",
			Buffer.concat([authData, sha256(clientDataJSON)]),
			overrides.signWith ?? credential.privateKey,
		)
		const userHandle =
			overrides.userHandle === null ? undefined : (overrides.userHandle ?? credential.userHandle)
		return {
			id: credential.id,
			rawId: credential.id,
			type: "public-key" as const,
			response: {
				clientDataJSON: b64(clientDataJSON),
				authenticatorData: b64(authData),
				signature: b64(signature),
				...(userHandle ? { userHandle } : {}),
			},
			authenticatorAttachment: "platform" as const,
			clientExtensionResults: {},
		}
	}
}
