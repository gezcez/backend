// moderation.module.ts

import { Module } from "@nestjs/common"
import { UsersModule } from "@services/users/users.module"
import { ModerationController } from "./moderation.controller"
import { ModerationRepository } from "./moderation.repository"
import { ModerationService } from "./moderation.service"

@Module({
	imports: [UsersModule],
	controllers: [ModerationController],
	providers: [ModerationService, ModerationRepository],
})
export class ModerationModule {}
