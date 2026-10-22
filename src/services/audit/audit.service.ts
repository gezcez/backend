// audit.service.ts
// Services call record() explicitly for auth events and admin writes (plan section 6.14).

import { Injectable, Logger } from "@nestjs/common"
import type { Request } from "express"
import { InjectConfig, type AppConfig } from "@common/config"
import { clientIp, hashIp } from "@common/utils"
import { AuditRepository } from "./audit.repository"

export type AuditAction =
	| "auth.code_sent"
	| "auth.code_failed"
	| "auth.login"
	| "auth.login_failed"
	| "auth.signup"
	| "auth.reauth"
	| "auth.logout"
	| "auth.session_switch"
	| "auth.session_revoked"
	| "auth.refresh_reuse"
	| "auth.code_replay"
	| "auth.token_issued"
	| "auth.password_reset"
	| "auth.password_changed"
	| "auth.email_changed"
	| "oauth.consent"
	| "oauth.grant_revoked"
	| "keys.rotated"
	| "roles.grant"
	| "roles.revoke"
	| "provider.kill"
	| "provider.unkill"
	| "catalog.sync"
	| "tracker.control"
	| "roles.created"
	| "roles.updated"
	| "roles.permissions_changed"
	| "permissions.deleted"
	| "users.email_revealed"
	| "users.session_revoked"
	| "users.sessions_revoked"
	| "moderation.ban"
	| "moderation.unban"
	| "apps.created"
	| "apps.updated"
	| "apps.deleted"
	| "apps.secret_rotated"
	| "apps.secret_revoked"
	| "apps.revoke_all"
	| "email.test_sent"
	| "email.suppression_removed"
	| "flags.updated"
	| "flags.critical_updated"
	| "settings.updated"
	| "jobs.run"
	| "account.export_requested"
	| "account.deletion_scheduled"
	| "account.deletion_cancelled"
	| "users.deleted"

export interface AuditContext {
	req?: Request
	actorUserId?: number | null
	actorClientId?: string | null
	target?: { type: string; id: string | number }
	networkId?: number | null
	data?: Record<string, unknown>
}

@Injectable()
export class AuditService {
	private readonly logger = new Logger("Audit")

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly repository: AuditRepository,
	) {}

	record(action: AuditAction, context: AuditContext = {}): void {
		const req = context.req
		try {
			this.repository.insert({
				action,
				actor_user_id:
					context.actorUserId ?? req?.session?.userId ?? req?.auth?.userId ?? null,
				actor_client_id: context.actorClientId ?? req?.auth?.clientId ?? null,
				target_type: context.target?.type ?? null,
				target_id: context.target ? String(context.target.id) : null,
				network_id: context.networkId ?? null,
				request_id: req?.id ? String(req.id) : null,
				ip_hash: req
					? hashIp(
							clientIp(req, this.config.trustCfHeaders),
							this.config.secrets.codePepper,
						)
					: null,
				data: context.data ?? null,
			})
		} catch (error) {
			// Auditing must never break the request it describes.
			this.logger.error({ err: error, action }, "Failed to write audit row")
		}
	}
}
