// revoked-sessions.service.ts
// In-memory set of recently revoked session ids, so access tokens of a revoked session stop
// working at once instead of living until they expire. Rebuilt from the database at boot and
// pruned after the longest access token lifetime.

import { Injectable, type OnModuleInit } from "@nestjs/common"
import { SessionRepository } from "./session.repository"

export const REVOKED_SID_WINDOW_MS = 15 * 60_000 + 60_000

@Injectable()
export class RevokedSessionsService implements OnModuleInit {
	private readonly revoked = new Map<string, number>()

	constructor(private readonly repository: SessionRepository) {}

	onModuleInit(): void {
		const since = new Date(Date.now() - REVOKED_SID_WINDOW_MS)
		for (const row of this.repository.revokedSince(since))
			this.revoked.set(row.id, row.revoked_at.getTime())
	}

	add(ids: string[], at = Date.now()): void {
		for (const id of ids) this.revoked.set(id, at)
		this.prune(at)
	}

	has(sid: string): boolean {
		return this.revoked.has(sid)
	}

	get size(): number {
		return this.revoked.size
	}

	private prune(now: number): void {
		for (const [id, at] of this.revoked)
			if (now - at > REVOKED_SID_WINDOW_MS) this.revoked.delete(id)
	}
}
