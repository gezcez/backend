// favourites.dto.ts
// The favourites document (plan 6.11), shaped like the mobile app's FavouritesDoc.

import { createZodDto } from "nestjs-zod"
import { z } from "zod"
import { FAVOURITE_COLOURS } from "@schemas/core/favourites"

export const FAVOURITES_MAX_GROUPS = 50
export const FAVOURITES_MAX_ITEMS = 500
export const FAVOURITES_MAX_TOMBSTONES = 2000

const Id = z.string().min(1).max(64)
const Timestamp = z.iso.datetime({ offset: true })

const ItemSchema = z.object({
	id: Id,
	kind: z.enum(["stop", "route"]),
	network_id: z
		.union([z.string().min(1).max(64), z.number().int().positive()])
		.describe("Network slug (returned) or numeric id (accepted)"),
	ref_id: z.string().min(1).max(200).describe("Stable public stop or route id"),
	label: z.string().max(120),
	direction: z.union([z.literal(0), z.literal(1)]).optional(),
	added_at: Timestamp,
	updated_at: Timestamp.optional(),
})

const GroupSchema = z.object({
	id: Id,
	name: z.string().max(60),
	colour: z.enum(FAVOURITE_COLOURS),
	position: z.number().int().min(0).max(10_000),
	updated_at: Timestamp.optional(),
	items: z.array(ItemSchema).max(FAVOURITES_MAX_ITEMS),
})

const TombstoneSchema = z.object({ id: Id, deleted_at: Timestamp })

export const FavouritesDocSchema = z.object({
	version: z.number().int().min(0),
	updated_at: Timestamp.nullable(),
	groups: z.array(GroupSchema).max(FAVOURITES_MAX_GROUPS),
	tombstones: z.array(TombstoneSchema).describe("Deletes from the last 30 days"),
})
export class FavouritesDocDto extends createZodDto(FavouritesDocSchema) {}

export const PutFavouritesSchema = FavouritesDocSchema.omit({ version: true, updated_at: true })
	.extend({
		version: z.number().int().min(0).optional(),
		updated_at: Timestamp.nullable().optional(),
		tombstones: z.array(TombstoneSchema).max(FAVOURITES_MAX_TOMBSTONES).default([]),
	})
	.superRefine((doc, ctx) => {
		const groupIds = new Set<string>()
		const itemIds = new Set<string>()
		let items = 0
		for (const group of doc.groups) {
			if (groupIds.has(group.id))
				ctx.addIssue({ code: "custom", message: `duplicate group id ${group.id}` })
			groupIds.add(group.id)
			for (const item of group.items) {
				items++
				if (itemIds.has(item.id) || groupIds.has(item.id))
					ctx.addIssue({ code: "custom", message: `duplicate item id ${item.id}` })
				itemIds.add(item.id)
			}
		}
		if (items > FAVOURITES_MAX_ITEMS)
			ctx.addIssue({ code: "custom", message: `at most ${FAVOURITES_MAX_ITEMS} favourites` })
	})
export class PutFavouritesDto extends createZodDto(PutFavouritesSchema) {}
