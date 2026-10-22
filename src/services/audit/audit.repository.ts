// audit.repository.ts

import { Injectable } from "@nestjs/common"
import { InjectCoreDb, type CoreDatabase } from "@db"
import { auditLogTable } from "@schemas/core"

export interface AuditInsert {
	action: string
	actor_user_id?: number | null
	actor_client_id?: string | null
	target_type?: string | null
	target_id?: string | null
	network_id?: number | null
	request_id?: string | null
	ip_hash?: string | null
	data?: Record<string, unknown> | null
}

@Injectable()
export class AuditRepository {
	constructor(@InjectCoreDb() private readonly db: CoreDatabase) {}

	insert(row: AuditInsert): void {
		this.db
			.insert(auditLogTable)
			.values({ ...row, at: new Date() })
			.run()
	}
}
