// breached-password.service.ts
// k-anonymity check against the Pwned Passwords range API: only the first 5 hex characters of
// the SHA-1 leave the server, with padding. Fails open (a network problem never blocks a
// password change). Under NODE_ENV=test nothing leaves the process unless a test sets fetchImpl.

import { createHash } from "node:crypto"
import { Injectable, Logger } from "@nestjs/common"
import { InjectConfig, type AppConfig } from "@common/config"

const RANGE_URL = "https://api.pwnedpasswords.com/range/"

@Injectable()
export class BreachedPasswordService {
	private readonly logger = new Logger("BreachedPassword")
	/** Replaceable in tests. */
	fetchImpl: (url: string, init: RequestInit) => Promise<Response>

	constructor(@InjectConfig() config: AppConfig) {
		this.fetchImpl = config.isTest
			? async () => new Response("", { status: 200 })
			: (url, init) => fetch(url, init)
	}

	async isBreached(password: string): Promise<boolean> {
		const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase()
		const prefix = sha1.slice(0, 5)
		const suffix = sha1.slice(5)
		try {
			const response = await this.fetchImpl(RANGE_URL + prefix, {
				headers: { "Add-Padding": "true" },
				signal: AbortSignal.timeout(3000),
			})
			if (!response.ok) throw new Error(`range API answered ${response.status}`)
			const body = await response.text()
			return body.split("\n").some((line) => {
				const [hash, count] = line.trim().split(":")
				return hash === suffix && Number(count) > 0
			})
		} catch (error) {
			this.logger.warn(
				`Breach check skipped: ${error instanceof Error ? error.message : String(error)}`,
			)
			return false
		}
	}
}
