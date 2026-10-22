// provider-tokens.repository.ts
// TokenStore backed by vts.db `provider_tokens` (plan 8.4): access tokens survive restarts so a
// deploy does not re-authenticate. Tokens are sealed with KEY_ENCRYPTION_SECRET and never logged.
// Only the process that writes vts.db (tracker side) uses this store.

import { Injectable, Logger } from "@nestjs/common"
import { eq, sql } from "drizzle-orm"
import { InjectVtsDb, type VtsDatabase } from "@db"
import { InjectConfig, type AppConfig } from "@common/config"
import { seal, unseal } from "@common/utils"
import { providerTokensTable } from "@schemas/vts"
import type { StoredToken, TokenStore } from "./kentkart/kentkart.auth"

const PURPOSE = "provider-token"

@Injectable()
export class ProviderTokensRepository implements TokenStore {
	private readonly logger = new Logger("ProviderTokens")

	constructor(
		@InjectVtsDb() private readonly db: VtsDatabase,
		@InjectConfig() private readonly config: AppConfig,
	) {}

	load(realm: string): StoredToken | undefined {
		const row = this.db
			.select()
			.from(providerTokensTable)
			.where(eq(providerTokensTable.realm, realm))
			.get()
		if (!row) return undefined
		try {
			return {
				accessToken: unseal(
					this.config.secrets.keyEncryption,
					PURPOSE,
					row.access_token_enc,
				),
				expiresAt: row.expires_at,
				issuedAt: row.issued_at,
				refreshedAt: row.refreshed_at,
			}
		} catch {
			// Key rotated or row corrupt: behave as if there was no token.
			this.logger.warn(`stored token for ${realm} could not be unsealed; refreshing`)
			return undefined
		}
	}

	save(realm: string, token: StoredToken): void {
		const values = {
			access_token_enc: seal(this.config.secrets.keyEncryption, PURPOSE, token.accessToken),
			expires_at: token.expiresAt,
			issued_at: token.issuedAt,
			refreshed_at: token.refreshedAt,
			failures: 0,
		}
		this.db
			.insert(providerTokensTable)
			.values({ realm, ...values })
			.onConflictDoUpdate({ target: providerTokensTable.realm, set: values })
			.run()
	}

	recordFailure(realm: string, failures: number): void {
		this.db
			.update(providerTokensTable)
			.set({ failures: sql`${failures}` })
			.where(eq(providerTokensTable.realm, realm))
			.run()
	}
}
