// refs.module.ts
// Global: id to reference-shape lookups for every dashboard module.

import { Global, Module } from "@nestjs/common"
import { RefsRepository } from "./refs.repository"
import { RefsService } from "./refs.service"

@Global()
@Module({ providers: [RefsRepository, RefsService], exports: [RefsService] })
export class RefsModule {}
