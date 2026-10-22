// seed.steps.ts
// The seed steps, shared by scripts/seed.ts and the test harness so e2e runs on the same rows.

import type { AppConfig } from "@common/config"
import type { CoreDatabase } from "@db"

export type SeedEnvironment = "production" | "staging" | "local" | "test"

export interface SeedContext {
	environment: SeedEnvironment
	config: AppConfig
}

export interface SeedStep {
	name: string
	/** Upserts rows and returns a short summary. Must be idempotent. */
	run(db: CoreDatabase, context: SeedContext): string
}

export const SEED_STEPS: SeedStep[] = []
