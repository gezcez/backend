// crypto.utils.ts
// Hashing, random values, constant-time comparison, AES-256-GCM sealing and prefixed ULIDs.

import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto"
import { ulid } from "ulid"

export function sha256Hex(input: string | Uint8Array): string {
	return createHash("sha256").update(input).digest("hex")
}

export function sha256Base64Url(input: string | Uint8Array): string {
	return createHash("sha256").update(input).digest("base64url")
}

export function hmacHex(secret: string, input: string): string {
	return createHmac("sha256", secret).update(input).digest("hex")
}

export function hmacBase64Url(secret: string, input: string): string {
	return createHmac("sha256", secret).update(input).digest("base64url")
}

/** URL-safe random token with `bytes` bytes of entropy (default 256 bits). */
export function randomToken(bytes = 32): string {
	return randomBytes(bytes).toString("base64url")
}

/** Uniformly distributed numeric code, e.g. a 6-digit email code. */
export function randomDigits(length: number): string {
	let out = ""
	while (out.length < length) {
		const byte = randomBytes(1)[0]!
		// Reject 250..255 so every digit is equally likely.
		if (byte < 250) out += String(byte % 10)
	}
	return out
}

export function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a)
	const right = Buffer.from(b)
	if (left.length !== right.length) return false
	return timingSafeEqual(left, right)
}

/** `prefix_` + ULID (ar_, fl_, ...) or a bare ULID. */
export function newId(prefix?: string): string {
	return prefix ? `${prefix}_${ulid()}` : ulid()
}

function deriveKey(secret: string, purpose: string): Buffer {
	return createHmac("sha256", secret).update(`gezcez:${purpose}`).digest()
}

/** AES-256-GCM. Output: base64url(iv | tag | ciphertext). `purpose` separates key domains. */
export function seal(secret: string, purpose: string, plaintext: string): string {
	const iv = randomBytes(12)
	const cipher = createCipheriv("aes-256-gcm", deriveKey(secret, purpose), iv)
	const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
	return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")
}

export function unseal(secret: string, purpose: string, sealed: string): string {
	const raw = Buffer.from(sealed, "base64url")
	if (raw.length < 29) throw new Error("sealed value too short")
	const decipher = createDecipheriv(
		"aes-256-gcm",
		deriveKey(secret, purpose),
		raw.subarray(0, 12),
	)
	decipher.setAuthTag(raw.subarray(12, 28))
	return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")
}

/**
 * Short-lived signed token (profile_token, reset_token): base64url(json).hmac.
 * Stateless; callers bind it to state that changes on use when single use matters.
 */
export function signToken(
	secret: string,
	purpose: string,
	payload: Record<string, unknown>,
	ttlMs: number,
): string {
	const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString(
		"base64url",
	)
	return `${body}.${hmacBase64Url(secret, `${purpose}.${body}`)}`
}

export function verifyToken<T extends Record<string, unknown>>(
	secret: string,
	purpose: string,
	token: string,
): (T & { exp: number }) | null {
	const [body, signature, extra] = token.split(".")
	if (!body || !signature || extra !== undefined) return null
	if (!safeEqual(signature, hmacBase64Url(secret, `${purpose}.${body}`))) return null
	try {
		const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & {
			exp: number
		}
		if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null
		return payload
	} catch {
		return null
	}
}
