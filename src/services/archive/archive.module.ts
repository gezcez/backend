// archive.module.ts
// Parquet archive (plan 6.8): export, verification, upload seam, manifest, nightly schedules and
// the dashboard archive endpoints. Registered in every process; only the process that owns
// vts.db writes (ArchiveService.canWrite), MODE=api serves the manifest read-only.

import { Module, type DynamicModule } from "@nestjs/common"
import { APP_CONFIG, type AppConfig } from "@common/config"
import { AggregatesJob } from "@services/analytics/aggregates.jobs"
import { ArchiveAdminController } from "./archive.controller"
import { ArchiveJobs } from "./archive.jobs"
import { ArchiveRepository } from "./archive.repository"
import { ArchiveService } from "./archive.service"
import { ARCHIVE_UPLOADER, createUploader } from "./archive.uploader"

@Module({})
export class ArchiveModule {
	static forRoot(options: { http: boolean } = { http: true }): DynamicModule {
		return {
			module: ArchiveModule,
			global: true,
			controllers: options.http ? [ArchiveAdminController] : [],
			providers: [
				ArchiveRepository,
				ArchiveService,
				AggregatesJob,
				ArchiveJobs,
				{
					provide: ARCHIVE_UPLOADER,
					useFactory: (config: AppConfig) => createUploader(config.analytics),
					inject: [APP_CONFIG],
				},
			],
			exports: [ArchiveRepository, ArchiveService, AggregatesJob, ArchiveJobs],
		}
	}
}
