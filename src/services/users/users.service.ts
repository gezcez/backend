// users.service.ts

import { Injectable } from "@nestjs/common"
import { hasPermission } from "@common/authorization"
import { GezcezError } from "@common/errors"
import type { RequestAuth } from "@common/jwt.types"
import { PERMISSION_KEYS, PERMISSIONS } from "@common/permission-keys"
import { initials, maskEmail } from "@common/utils"
import { PermissionCacheService } from "@services/roles/permission-cache.service"
import { RolesService } from "@services/roles/roles.service"
import type { MeDto, PatchMeDto } from "./users.dto"
import { UsersRepository } from "./users.repository"

@Injectable()
export class UsersService {
	constructor(
		private readonly repository: UsersRepository,
		private readonly roles: RolesService,
		private readonly permissions: PermissionCacheService,
	) {}

	/**
	 * Scoped by the token: staff roles and permissions need `dash`, the name and username need
	 * `profile`, the masked email needs `email`. A third-party token with only `openid` gets the
	 * subject id, locale and auth facts.
	 */
	me(auth: RequestAuth): MeDto {
		const user = this.repository.findById(auth.userId)
		if (!user) throw new GezcezError("AUTH_SESSION_REVOKED")
		const profile = auth.scopes.includes("profile")
		const email = auth.scopes.includes("email")
		if (!auth.scopes.includes("dash")) {
			return {
				user: {
					id: user.public_id,
					display_name: profile ? user.display_name : "",
					username: profile ? user.username : null,
					email_masked: email ? maskEmail(user.email) : "",
					locale: user.locale,
					avatar_initials: profile ? initials(user.display_name) : "",
				},
				auth_time: auth.authTime,
				amr: auth.amr,
				global: { roles: [], permissions: [] },
				networks: [],
			}
		}
		const permissions = this.permissions.forUser(user.id)
		const assignments = this.roles.assignments(user.id)

		const networks = new Map<number, MeDto["networks"][number]>()
		const globalRoles: MeDto["global"]["roles"] = []
		for (const { role, network } of assignments) {
			if (!network) {
				globalRoles.push(role)
				continue
			}
			let entry = networks.get(network.id)
			if (!entry) {
				entry = {
					id: network.id,
					slug: network.slug,
					name: network.name,
					city: {
						id: network.city.id,
						slug: network.city.slug,
						name: network.city.name[user.locale],
					},
					roles: [],
					// Effective set: the network's grants plus network keys held globally.
					permissions: PERMISSION_KEYS.filter(
						(key) =>
							PERMISSIONS[key].scope !== "global" &&
							hasPermission(permissions, key, network.id),
					),
				}
				networks.set(network.id, entry)
			}
			entry.roles.push(role)
		}

		return {
			user: {
				id: user.public_id,
				display_name: user.display_name,
				username: user.username,
				email_masked: maskEmail(user.email),
				locale: user.locale,
				avatar_initials: initials(user.display_name),
			},
			auth_time: auth.authTime,
			amr: auth.amr,
			global: {
				roles: globalRoles,
				// root bypasses checks, so it effectively holds every key.
				permissions: PERMISSION_KEYS.filter(
					(key) => permissions.root || permissions.global.has(key),
				),
			},
			networks: [...networks.values()],
		}
	}

	update(auth: RequestAuth, body: PatchMeDto): MeDto {
		this.repository.updateProfile(
			auth.userId,
			{
				...(body.display_name !== undefined ? { display_name: body.display_name } : {}),
				...(body.locale !== undefined ? { locale: body.locale } : {}),
			},
			new Date(),
		)
		return this.me(auth)
	}
}
