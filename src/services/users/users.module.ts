// users.module.ts
// /v1/me now; dashboard user search, detail and admin session management arrive in P2.

import { Module } from "@nestjs/common"
import { UsersController } from "./users.controller"
import { UsersRepository } from "./users.repository"
import { UsersService } from "./users.service"

@Module({
	controllers: [UsersController],
	providers: [UsersService, UsersRepository],
})
export class UsersModule {}
