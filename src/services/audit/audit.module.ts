// audit.module.ts

import { Global, Module } from "@nestjs/common"
import { AuditRepository } from "./audit.repository"
import { AuditService } from "./audit.service"

@Global()
@Module({ providers: [AuditService, AuditRepository], exports: [AuditService] })
export class AuditModule {}
