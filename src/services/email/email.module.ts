// email.module.ts

import { Global, Module } from "@nestjs/common"
import { EmailAdminController } from "./email-admin.controller"
import { EmailAdminRepository } from "./email-admin.repository"
import { EmailAdminService } from "./email-admin.service"
import { EmailRepository } from "./email.repository"
import { EmailService } from "./email.service"

@Global()
@Module({
	controllers: [EmailAdminController],
	providers: [EmailService, EmailRepository, EmailAdminService, EmailAdminRepository],
	exports: [EmailService],
})
export class EmailModule {}
