// signing_keys.ts
// ES256 keys for access tokens. Private keys are sealed with KEY_ENCRYPTION_SECRET.

import { int, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const signingKeysTable = sqliteTable("signing_keys", {
	kid: text().primaryKey(),
	alg: text().$type<"ES256">().notNull(),
	public_jwk: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
	private_jwk_enc: text().notNull(),
	created_at: int({ mode: "timestamp_ms" }).notNull(),
	active_from: int({ mode: "timestamp_ms" }).notNull(),
	retire_after: int({ mode: "timestamp_ms" }),
})

export type SigningKeyRow = typeof signingKeysTable.$inferSelect
