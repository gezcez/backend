// favourites.service.ts
// The rider's favourites as one versioned document (plan 6.11). GET returns it with
// `ETag: "<version>"`; PUT replaces it when If-Match names the current version, otherwise
// 412 VERSION_CONFLICT so the app merges (by id, last writer wins) and retries. Ids missing from
// a PUT become tombstones, kept 30 days so other devices learn about deletes.

import { Injectable } from "@nestjs/common"
import { GezcezError } from "@common/errors"
import type { FavouriteGroupRow, FavouriteRow } from "@schemas/core"
import { NetworksService } from "@services/networks/networks.service"
import type { FavouritesDocDto, PutFavouritesDto } from "./favourites.dto"
import { FavouritesRepository, type GroupInput, type ItemInput } from "./favourites.repository"

export const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000

const iso = (ms: number) => new Date(ms).toISOString()

/** `"3"`, `W/"3"` or `3` to 3; anything else is null. */
export function parseIfMatch(header: string | undefined): number | null {
	if (header === undefined) return null
	const value = header.trim().replace(/^W\//, "").replace(/"/g, "")
	return /^\d{1,15}$/.test(value) ? Number(value) : null
}

@Injectable()
export class FavouritesService {
	/** Overridable clock for tests. */
	now: () => number = () => Date.now()

	constructor(
		private readonly repository: FavouritesRepository,
		private readonly networks: NetworksService,
	) {}

	get(userId: number): FavouritesDocDto {
		this.repository.purge(userId, this.now() - TOMBSTONE_TTL_MS)
		return this.document(userId)
	}

	put(userId: number, ifMatch: string | undefined, body: PutFavouritesDto): FavouritesDocDto {
		const expected = parseIfMatch(ifMatch) ?? body.version
		if (expected === undefined || expected === null)
			throw new GezcezError(
				"VALIDATION_FAILED",
				"If-Match with the document version is required",
			)
		const now = this.now()
		const groups: GroupInput[] = []
		const items: ItemInput[] = []
		for (const group of body.groups) {
			groups.push({
				id: group.id,
				name: group.name,
				colour: group.colour,
				position: group.position,
				updated_at: group.updated_at ? Date.parse(group.updated_at) : now,
			})
			group.items.forEach((item, position) => {
				const addedAt = Date.parse(item.added_at)
				items.push({
					id: item.id,
					group_id: group.id,
					kind: item.kind,
					network_id: this.networkId(item.network_id),
					ref_id: item.ref_id,
					label: item.label,
					direction: item.direction ?? null,
					position,
					added_at: addedAt,
					updated_at: item.updated_at ? Date.parse(item.updated_at) : addedAt,
				})
			})
		}
		const tombstones = new Map(
			body.tombstones.map((t) => [t.id, Math.min(Date.parse(t.deleted_at), now)] as const),
		)
		const version = this.repository.replace(
			userId,
			expected,
			{ groups, items, tombstones },
			now,
		)
		if (version === null) {
			const current = this.repository.state(userId)?.version ?? 0
			throw new GezcezError("VERSION_CONFLICT", undefined, { current_version: current })
		}
		this.repository.purge(userId, now - TOMBSTONE_TTL_MS)
		return this.document(userId)
	}

	private networkId(ref: string | number): number {
		try {
			return this.networks.network(String(ref), false).id
		} catch {
			throw new GezcezError("VALIDATION_FAILED", `Unknown network ${ref}`)
		}
	}

	private document(userId: number): FavouritesDocDto {
		const state = this.repository.state(userId)
		const slugs = new Map(
			this.networks.listNetworks({ publicOnly: false }).map((n) => [n.id, n.slug]),
		)
		const rows = this.repository.items(userId)
		const tombstones: { id: string; deleted_at: number }[] = []
		const itemsByGroup = new Map<string, FavouriteRow[]>()
		for (const row of rows) {
			if (row.deleted_at !== null) {
				tombstones.push({ id: row.id, deleted_at: row.deleted_at })
				continue
			}
			const list = itemsByGroup.get(row.group_id) ?? []
			list.push(row)
			itemsByGroup.set(row.group_id, list)
		}
		const live: FavouriteGroupRow[] = []
		for (const group of this.repository.groups(userId)) {
			if (group.deleted_at !== null)
				tombstones.push({ id: group.id, deleted_at: group.deleted_at })
			else live.push(group)
		}
		live.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
		tombstones.sort((a, b) => b.deleted_at - a.deleted_at)
		return {
			version: state?.version ?? 0,
			updated_at: state ? iso(state.updated_at) : null,
			groups: live.map((g) => ({
				id: g.id,
				name: g.name,
				colour: g.colour,
				position: g.position,
				updated_at: iso(g.updated_at),
				items: (itemsByGroup.get(g.id) ?? [])
					.sort((a, b) => a.position - b.position)
					.map((i) => ({
						id: i.id,
						kind: i.kind,
						network_id: slugs.get(i.network_id) ?? String(i.network_id),
						ref_id: i.ref_id,
						label: i.label,
						...(i.direction === 0 || i.direction === 1
							? { direction: i.direction }
							: {}),
						added_at: iso(i.added_at),
						updated_at: iso(i.updated_at),
					})),
			})),
			tombstones: tombstones.map((t) => ({ id: t.id, deleted_at: iso(t.deleted_at) })),
		}
	}
}
