// favourites.ts
// Rider favourites as a versioned document (plan 5.1 and 6.11). Ids come from the client
// (uuid v7). Deleted rows stay as tombstones for 30 days so other devices learn about deletes.

import { index, int, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { usersTable } from "./users"

export const FAVOURITE_COLOURS = [
	"amber",
	"navy",
	"teal",
	"rose",
	"violet",
	"green",
	"orange",
	"slate",
] as const
export type FavouriteColour = (typeof FAVOURITE_COLOURS)[number]

export const favouriteGroupsTable = sqliteTable(
	"favourite_groups",
	{
		user_id: int()
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		id: text().notNull(),
		name: text().notNull(),
		colour: text().$type<FavouriteColour>().notNull(),
		position: int().notNull(),
		/** Unix ms. */
		updated_at: int().notNull(),
		deleted_at: int(),
	},
	(t) => [primaryKey({ columns: [t.user_id, t.id] })],
)

export const favouritesTable = sqliteTable(
	"favourites",
	{
		user_id: int()
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		id: text().notNull(),
		group_id: text().notNull(),
		kind: text().$type<"stop" | "route">().notNull(),
		network_id: int().notNull(),
		/** Stable public id (`<binding>.<external>`). */
		ref_id: text().notNull(),
		label: text().notNull(),
		direction: int(),
		position: int().notNull().default(0),
		/** Unix ms. */
		added_at: int().notNull(),
		updated_at: int().notNull(),
		deleted_at: int(),
	},
	(t) => [
		primaryKey({ columns: [t.user_id, t.id] }),
		index("favourites_user_updated_idx").on(t.user_id, t.updated_at),
	],
)

export const favouritesStateTable = sqliteTable("favourites_state", {
	user_id: int()
		.primaryKey()
		.references(() => usersTable.id, { onDelete: "cascade" }),
	/** Bumped on every accepted PUT; the ETag for If-Match. */
	version: int().notNull(),
	/** Unix ms. */
	updated_at: int().notNull(),
})

export type FavouriteGroupRow = typeof favouriteGroupsTable.$inferSelect
export type FavouriteRow = typeof favouritesTable.$inferSelect
