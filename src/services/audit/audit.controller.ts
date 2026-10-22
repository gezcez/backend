// audit.controller.ts
// GET /v1/dash/audit (audit.read, global) and GET /v1/dash/networks/:networkId/audit (audit.read
// in that network).

import { Controller, Get, Param, Query, Req } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Request } from "express"
import { ApiEnvelope, UseAuthorization } from "@common/middlewares"
import { AuditPageDto, AuditQueryDto, NetworkAuditQueryDto } from "./audit.dto"
import { AuditQueryService } from "./audit-query.service"

@ApiTags("dash")
@Controller("dash")
export class AuditController {
	constructor(private readonly audit: AuditQueryService) {}

	@Get("audit")
	@UseAuthorization({
		permission: "audit.read",
		scope: "global",
		description: "Read the audit log",
	})
	@ApiOperation({ summary: "Audit log, newest first; before/after redacted" })
	@ApiEnvelope(AuditPageDto)
	list(@Query() query: AuditQueryDto): AuditPageDto {
		return this.audit.list(query)
	}

	@Get("networks/:networkId/audit")
	@UseAuthorization({
		permission: "audit.read",
		scope: "network",
		description: "Read a network's audit log",
	})
	@ApiOperation({ summary: "Audit entries of one network" })
	@ApiEnvelope(AuditPageDto)
	network(
		@Param("networkId") _networkId: string,
		@Query() query: NetworkAuditQueryDto,
		@Req() req: Request,
	): AuditPageDto {
		return this.audit.list(query, req.networkId)
	}
}
