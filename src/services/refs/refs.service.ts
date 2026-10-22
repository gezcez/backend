// refs.service.ts
// Resolves internal ids to UserRef / NetworkRef / RoleRef in one query per kind, and public user
// ids (ULIDs in URLs) to internal ids.

import { Injectable } from "@nestjs/common"
import { GezcezError } from "@common/errors"
import type { NetworkRef, UserRef } from "@common/models/dash.models"
import { RefsRepository, type UserRefRow } from "./refs.repository"

type Maybe = number | null | undefined

function unique(ids: Maybe[]): number[] {
	return [...new Set(ids.filter((id): id is number => typeof id === "number"))]
}

export function toUserRef(row: UserRefRow): UserRef {
	return { id: row.public_id, display_name: row.display_name, username: row.username }
}

@Injectable()
export class RefsService {
	constructor(private readonly repository: RefsRepository) {}

	/** Internal user ids to UserRef; ids of deleted users are missing from the map. */
	users(ids: Maybe[]): Map<number, UserRef> {
		return new Map(this.repository.users(unique(ids)).map((row) => [row.id, toUserRef(row)]))
	}

	networks(ids: Maybe[]): Map<number, NetworkRef> {
		return new Map(this.repository.networks(unique(ids)).map((row) => [row.id, row]))
	}

	roles(ids: Maybe[]) {
		return new Map(this.repository.roles(unique(ids)).map((row) => [row.id, row]))
	}

	appNames(clientIds: (string | null | undefined)[]): Map<string, string> {
		const ids = [...new Set(clientIds.filter((id): id is string => !!id))]
		return new Map(this.repository.apps(ids).map((row) => [row.client_id, row.name]))
	}

	/** The internal id behind a public user id, or NOT_FOUND. */
	userId(publicId: string): number {
		return this.user(publicId).id
	}

	user(publicId: string): UserRefRow {
		const row = this.repository.userByPublicId(publicId)
		if (!row) throw new GezcezError("NOT_FOUND", "User not found")
		return row
	}

	/** Like user(), but undefined instead of NOT_FOUND (filters). */
	findUser(publicId: string): UserRefRow | undefined {
		return this.repository.userByPublicId(publicId)
	}
}
