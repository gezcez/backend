// email.module.ts

import { Global, Module } from "@nestjs/common"
import { EmailRepository } from "./email.repository"
import { EmailService } from "./email.service"

@Global()
@Module({
	providers: [EmailService, EmailRepository],
	exports: [EmailService],
})
export class EmailModule {}
