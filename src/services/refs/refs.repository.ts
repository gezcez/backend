// refs.repository.ts
// Batched lookups that turn internal ids into the public reference shapes.

import { Injectable } from "@nestjs/common"
import { eq, inArray } from "drizzle-orm"
import { InjectCoreDb, type CoreDatabase } from "@db"
import { appsTable, networksTable, rolesTable, usersTable } from "@schemas/core"

export interface UserRefRow {
	id: number
	public_id: string
	display_name: string
	username: string | null
}

@Injectable()
export class RefsRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	users(ids: number[]): UserRefRow[] {
		if (ids.length === 0) return []
		return this.db
			.select({
				id: usersTable.id,
				public_id: usersTable.public_id,
				display_name: usersTable.display_name,
				username: usersTable.username,
			})
			.from(usersTable)
			.where(inArray(usersTable.id, ids))
			.all()
	}

	userByPublicId(publicId: string): UserRefRow | undefined {
		return this.db
			.select({
				id: usersTable.id,
				public_id: usersTable.public_id,
				display_name: usersTable.display_name,
				username: usersTable.username,
			})
			.from(usersTable)
			.where(eq(usersTable.public_id, publicId))
			.get()
	}

	networks(ids: number[]): { id: number; slug: string; name: string }[] {
		if (ids.length === 0) return []
		return this.db
			.select({ id: networksTable.id, slug: networksTable.slug, name: networksTable.name })
			.from(networksTable)
			.where(inArray(networksTable.id, ids))
			.all()
	}

	apps(clientIds: string[]): { client_id: string; name: string }[] {
		if (clientIds.length === 0) return []
		return this.db
			.select({ client_id: appsTable.client_id, name: appsTable.name })
			.from(appsTable)
			.where(inArray(appsTable.client_id, clientIds))
			.all()
	}

	roles(ids: number[]): { id: number; key: string; name: string; level: number }[] {
		if (ids.length === 0) return []
		return this.db
			.select({
				id: rolesTable.id,
				key: rolesTable.key,
				name: rolesTable.name,
				level: rolesTable.level,
			})
			.from(rolesTable)
			.where(inArray(rolesTable.id, ids))
			.all()
	}
}
