// binding-health.registry.ts
// The tracker publishes per-binding runtime state here (ok, degraded, down...) so catalog
// endpoints can derive network status without importing the tracker module.

import { Injectable } from "@nestjs/common"

export type BindingRuntimeState = "ok" | "degraded" | "down" | "paused" | "killed" | "unknown"

export interface BindingRuntime {
	state: BindingRuntimeState
	message?: string | null
	/** Unix seconds of the last accepted feed. */
	lastFeedTs?: number | null
}

export type BindingRuntimeSource = (bindingId: number) => BindingRuntime | undefined

@Injectable()
export class BindingHealthRegistry {
	private source: BindingRuntimeSource | undefined

	register(source: BindingRuntimeSource): void {
		this.source = source
	}

	get(bindingId: number): BindingRuntime | undefined {
		return this.source?.(bindingId)
	}
}
