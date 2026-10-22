// test-mailbox.controller.ts
// GET /v1/__test/mailbox?to= lets e2e suites read codes. The module is only loaded when
// NODE_ENV=test (see app.module.ts), so the route does not exist anywhere else.

import { Controller, Get, Module, Query } from "@nestjs/common"
import { ApiExcludeController } from "@nestjs/swagger"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"
import { GezcezError } from "@common/errors"
import { Public } from "@common/middlewares"
import { EmailService } from "./email.service"
import { MemoryTransport } from "./email.transports"

class MailboxQueryDto extends createZodDto(z.object({ to: z.string().min(3) })) {}

@ApiExcludeController()
@Public()
@Controller("__test/mailbox")
export class TestMailboxController {
	constructor(private readonly email: EmailService) {}

	@Get()
	mailbox(@Query() query: MailboxQueryDto) {
		if (!(this.email.transport instanceof MemoryTransport)) {
			throw new GezcezError("NOT_FOUND", "The test mailbox needs EMAIL_TRANSPORT=memory")
		}
		return { messages: this.email.transport.for(query.to) }
	}
}

@Module({ controllers: [TestMailboxController] })
export class TestMailboxModule {}
