// apps.module.ts

import { Module } from "@nestjs/common"
import { AppsController } from "./apps.controller"
import { AppsRepository } from "./apps.repository"
import { AppsService } from "./apps.service"

@Module({ controllers: [AppsController], providers: [AppsService, AppsRepository] })
export class AppsModule {}
