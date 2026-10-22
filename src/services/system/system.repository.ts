// system.repository.ts

import { Injectable } from "@nestjs/common"
import { DatabaseService } from "@db"

@Injectable()
export class SystemRepository {
	constructor(private readonly database: DatabaseService) {}

	databaseChecks(): { name: string; ok: boolean }[] {
		return this.database.check()
	}
}
