// audit-query.service.ts
// Audit log reads for the dashboard (global, network-scoped, per user).

import { Injectable } from "@nestjs/common"
import type { Page, PageQuery } from "@common/response"
import type { AuditLogRow } from "@schemas/core"
import { RefsService } from "@services/refs/refs.service"
import type { AuditEntry, AuditQueryDto, NetworkAuditQueryDto } from "./audit.dto"
import { presentAudit } from "./audit.presenter"
import { AuditRepository, type AuditFilter } from "./audit.repository"

@Injectable()
export class AuditQueryService {
	constructor(
		private readonly repository: AuditRepository,
		private readonly refs: RefsService,
	) {}

	list(query: AuditQueryDto | NetworkAuditQueryDto, networkId?: number): Page<AuditEntry> {
		const filter: AuditFilter = {
			action: query.action,
			targetType: query.target_type,
			networkId: networkId ?? ("network_id" in query ? query.network_id : undefined),
			from: query.from ? new Date(query.from) : undefined,
			to: query.to ? new Date(query.to) : undefined,
		}
		if (query.actor) {
			// An unknown actor matches nothing rather than everything.
			filter.actorUserId = this.refs.findUser(query.actor)?.id ?? -1
		}
		if (query.target_id) {
			filter.targetId = query.target_id
			filter.targetUserId = this.refs.findUser(query.target_id)?.id
		}
		return this.present(this.repository.page(filter, query))
	}

	forUser(userId: number, query: PageQuery): Page<AuditEntry> {
		return this.present(this.repository.page({ involvingUserId: userId }, query))
	}

	present(page: Page<AuditLogRow>): Page<AuditEntry> {
		const rows = page.items
		const userIds = rows.flatMap((row) => [
			row.actor_user_id,
			row.target_type === "user" ? Number(row.target_id) : null,
		])
		const of = (type: string) =>
			rows.filter((row) => row.target_type === type).map((row) => Number(row.target_id))
		const lookups = {
			users: this.refs.users(userIds),
			apps: this.refs.appNames(
				rows.filter((row) => row.target_type === "app").map((row) => row.target_id),
			),
			networks: this.refs.networks(of("network")),
			roles: this.refs.roles(of("role")),
		}
		return { ...page, items: rows.map((row) => presentAudit(row, lookups)) }
	}
}
