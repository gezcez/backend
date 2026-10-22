// refresh-grace.service.ts
// Rotation grace window (plan section 6.1.3): for REFRESH_GRACE_S after a rotation, presenting
// the predecessor again returns the same successor instead of triggering reuse detection. The
// successor's plaintext is kept sealed (AES-GCM, SEAL_SECRET) in memory only, keyed by the
// predecessor's hash, and dropped when the window ends.

import { Injectable } from "@nestjs/common"
import { InjectConfig, type AppConfig } from "@common/config"
import { seal, unseal } from "@common/utils"

const PURPOSE = "refresh-grace"

@Injectable()
export class RefreshGraceService {
	private readonly entries = new Map<string, { sealed: string; until: number }>()

	constructor(@InjectConfig() private readonly config: AppConfig) {}

	remember(predecessorHash: string, successorPlaintext: string, now = Date.now()): void {
		this.prune(now)
		this.entries.set(predecessorHash, {
			sealed: seal(this.config.secrets.seal, PURPOSE, successorPlaintext),
			until: now + this.config.refreshGraceS * 1000,
		})
	}

	/** The successor's plaintext while the window is open, otherwise undefined. */
	successor(predecessorHash: string, now = Date.now()): string | undefined {
		const entry = this.entries.get(predecessorHash)
		if (!entry) return undefined
		if (entry.until < now) {
			this.entries.delete(predecessorHash)
			return undefined
		}
		return unseal(this.config.secrets.seal, PURPOSE, entry.sealed)
	}

	get size(): number {
		return this.entries.size
	}

	private prune(now: number): void {
		for (const [key, entry] of this.entries) if (entry.until < now) this.entries.delete(key)
	}
}
