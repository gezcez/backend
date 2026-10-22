// system.service.ts

import { Injectable } from "@nestjs/common"
import { InjectConfig, type AppConfig } from "@common/config"
import { SystemRepository } from "./system.repository"

export interface ReadyCheck {
	name: string
	ok: boolean
}

/** Extra readiness checks registered by other modules (signing key loaded, tracker alive...). */
export type ReadinessProbe = () => ReadyCheck | Promise<ReadyCheck>

@Injectable()
export class SystemService {
	private readonly started = Date.now()
	private readonly probes: ReadinessProbe[] = []

	constructor(
		@InjectConfig() private readonly config: AppConfig,
		private readonly repository: SystemRepository,
	) {}

	registerProbe(probe: ReadinessProbe): void {
		this.probes.push(probe)
	}

	async readiness(): Promise<{ ready: boolean; checks: ReadyCheck[] }> {
		const checks: ReadyCheck[] = this.repository.databaseChecks().map((check) => ({
			name: `db.${check.name}`,
			ok: check.ok,
		}))
		for (const probe of this.probes) {
			try {
				checks.push(await probe())
			} catch {
				checks.push({ name: "probe", ok: false })
			}
		}
		return { ready: checks.every((check) => check.ok), checks }
	}

	version() {
		return {
			version: this.config.version.packageVersion,
			git_sha: this.config.version.gitSha,
			build_time: this.config.version.buildTime ?? null,
			mode: this.config.mode,
			env: this.config.env,
			uptime_s: Math.round((Date.now() - this.started) / 1000),
		}
	}
}
