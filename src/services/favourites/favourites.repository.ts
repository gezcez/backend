// favourites.repository.ts
// core.db access for the favourites document: rows per group and item, tombstones, and the
// per-user version used for If-Match. A PUT is one transaction that checks the version first.

import { Injectable } from "@nestjs/common"
import { and, eq, isNotNull, lt } from "drizzle-orm"
import { InjectCoreDb, type CoreDatabase } from "@db"
import {
	favouriteGroupsTable,
	favouritesStateTable,
	favouritesTable,
	type FavouriteGroupRow,
	type FavouriteRow,
} from "@schemas/core"

export type GroupInput = Omit<FavouriteGroupRow, "user_id" | "deleted_at">
export type ItemInput = Omit<FavouriteRow, "user_id" | "deleted_at">

export interface ReplaceInput {
	groups: GroupInput[]
	items: ItemInput[]
	/** Client tombstones: id to deleted_at (ms). */
	tombstones: Map<string, number>
}

@Injectable()
export class FavouritesRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	state(userId: number): { version: number; updated_at: number } | undefined {
		return this.db
			.select({
				version: favouritesStateTable.version,
				updated_at: favouritesStateTable.updated_at,
			})
			.from(favouritesStateTable)
			.where(eq(favouritesStateTable.user_id, userId))
			.get()
	}

	groups(userId: number): FavouriteGroupRow[] {
		return this.db
			.select()
			.from(favouriteGroupsTable)
			.where(eq(favouriteGroupsTable.user_id, userId))
			.all()
	}

	items(userId: number): FavouriteRow[] {
		return this.db
			.select()
			.from(favouritesTable)
			.where(eq(favouritesTable.user_id, userId))
			.all()
	}

	/** Drops tombstones older than `before` (ms). */
	purge(userId: number, before: number): void {
		this.db
			.delete(favouritesTable)
			.where(
				and(
					eq(favouritesTable.user_id, userId),
					isNotNull(favouritesTable.deleted_at),
					lt(favouritesTable.deleted_at, before),
				),
			)
			.run()
		this.db
			.delete(favouriteGroupsTable)
			.where(
				and(
					eq(favouriteGroupsTable.user_id, userId),
					isNotNull(favouriteGroupsTable.deleted_at),
					lt(favouriteGroupsTable.deleted_at, before),
				),
			)
			.run()
	}

	/**
	 * Replaces the user's document when `expectedVersion` is current: upserts what the document
	 * holds, tombstones what it no longer holds, bumps the version. Returns null on a conflict.
	 */
	replace(
		userId: number,
		expectedVersion: number,
		input: ReplaceInput,
		now: number,
	): number | null {
		return this.db.transaction((tx) => {
			const current =
				tx
					.select({ version: favouritesStateTable.version })
					.from(favouritesStateTable)
					.where(eq(favouritesStateTable.user_id, userId))
					.get()?.version ?? 0
			if (current !== expectedVersion) return null

			const keepGroups = new Set(input.groups.map((g) => g.id))
			for (const g of tx
				.select()
				.from(favouriteGroupsTable)
				.where(eq(favouriteGroupsTable.user_id, userId))
				.all()) {
				if (g.deleted_at !== null || keepGroups.has(g.id)) continue
				tx.update(favouriteGroupsTable)
					.set({ deleted_at: input.tombstones.get(g.id) ?? now, updated_at: now })
					.where(
						and(
							eq(favouriteGroupsTable.user_id, userId),
							eq(favouriteGroupsTable.id, g.id),
						),
					)
					.run()
			}
			for (const g of input.groups) {
				const values = { ...g, deleted_at: null }
				tx.insert(favouriteGroupsTable)
					.values({ user_id: userId, ...values })
					.onConflictDoUpdate({
						target: [favouriteGroupsTable.user_id, favouriteGroupsTable.id],
						set: values,
					})
					.run()
			}

			const keepItems = new Set(input.items.map((i) => i.id))
			for (const i of tx
				.select()
				.from(favouritesTable)
				.where(eq(favouritesTable.user_id, userId))
				.all()) {
				if (i.deleted_at !== null || keepItems.has(i.id)) continue
				tx.update(favouritesTable)
					.set({ deleted_at: input.tombstones.get(i.id) ?? now, updated_at: now })
					.where(and(eq(favouritesTable.user_id, userId), eq(favouritesTable.id, i.id)))
					.run()
			}
			for (const i of input.items) {
				const values = { ...i, deleted_at: null }
				tx.insert(favouritesTable)
					.values({ user_id: userId, ...values })
					.onConflictDoUpdate({
						target: [favouritesTable.user_id, favouritesTable.id],
						set: values,
					})
					.run()
			}

			const version = current + 1
			tx.insert(favouritesStateTable)
				.values({ user_id: userId, version, updated_at: now })
				.onConflictDoUpdate({
					target: favouritesStateTable.user_id,
					set: { version, updated_at: now },
				})
				.run()
			return version
		})
	}
}
