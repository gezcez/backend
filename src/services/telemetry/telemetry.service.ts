// telemetry.service.ts
// Adds the app's daily counters to aggregate rows keyed by day, platform, version, city and key.
// Nothing that identifies a rider is stored; the route is also left out of the access log.

import { Injectable } from "@nestjs/common"
import { GezcezError } from "@common/errors"
import { NetworksService } from "@services/networks/networks.service"
import type { TelemetryCountersDto } from "./telemetry.dto"
import { TelemetryRepository } from "./telemetry.repository"

const DAY_MS = 86_400_000

@Injectable()
export class TelemetryService {
	now: () => number = () => Date.now()

	constructor(
		private readonly repository: TelemetryRepository,
		private readonly networks: NetworksService,
	) {}

	record(body: TelemetryCountersDto): { accepted: boolean } {
		const day = Date.parse(`${body.day}T00:00:00Z`)
		if (Math.abs(day - this.now()) > 2 * DAY_MS)
			throw new GezcezError("VALIDATION_FAILED", "day must be within two days of today")
		let city = ""
		if (body.city !== null) {
			try {
				city = this.networks.city(body.city).slug
			} catch {
				throw new GezcezError("VALIDATION_FAILED", `Unknown city ${body.city}`)
			}
		}
		this.repository.add({
			day: body.day,
			platform: body.platform,
			app_version: body.app_version,
			city_slug: city,
			counters: Object.entries(body.counters).filter(([, n]) => n > 0),
		})
		return { accepted: true }
	}
}
