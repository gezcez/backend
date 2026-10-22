// transit.db schema barrel (plan section 5.2). The FTS5 `search_index` table is created by a
// custom migration (drizzle has no virtual tables) and queried with raw SQL in the repository.

export * from "./feed_versions"
export * from "./static"
