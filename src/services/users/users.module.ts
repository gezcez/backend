// users.module.ts
// /v1/me, and the dashboard's user search, detail and admin session management.

import { Module } from "@nestjs/common"
import { DashUsersController } from "./dash-users.controller"
import { DashUsersRepository } from "./dash-users.repository"
import { DashUsersService } from "./dash-users.service"
import { UsersController } from "./users.controller"
import { UsersRepository } from "./users.repository"
import { UsersService } from "./users.service"

@Module({
	controllers: [UsersController, DashUsersController],
	providers: [UsersService, UsersRepository, DashUsersService, DashUsersRepository],
	exports: [DashUsersService, DashUsersRepository],
})
export class UsersModule {}
