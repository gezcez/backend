// audit.module.ts

import { Global, Module } from "@nestjs/common"
import { AuditQueryService } from "./audit-query.service"
import { AuditController } from "./audit.controller"
import { AuditRepository } from "./audit.repository"
import { AuditService } from "./audit.service"

@Global()
@Module({
	controllers: [AuditController],
	providers: [AuditService, AuditRepository, AuditQueryService],
	exports: [AuditService, AuditQueryService],
})
export class AuditModule {}
