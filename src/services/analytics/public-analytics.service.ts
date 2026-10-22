// public-analytics.service.ts
// The public slice of analytics (plan 6.9): a daily data reliability score per city
// (quality.feed over closed days) and fleet in service today and yesterday (fleet.hourly).
// Only public cities and networks, only aggregates. Metric results come from the analytics
// cache, and the routes are cached at Cloudflare.

import { Injectable } from "@nestjs/common"
import { GezcezError } from "@common/errors"
import { addDays, localTime } from "@common/utils"
import { NetworksService } from "@services/networks/networks.service"
import { AnalyticsQuerySchema, type MetricResult } from "./analytics.dto"
import { AnalyticsService } from "./analytics.service"

type Row = Record<string, unknown>

function objects(result: MetricResult): Row[] {
	return result.rows.map((row) => Object.fromEntries(result.columns.map((c, i) => [c, row[i]])))
}

const num = (value: unknown): number | null => (typeof value === "number" ? value : null)
const round1 = (value: number) => Math.round(value * 10) / 10

function mean(values: (number | null)[]): number | null {
	const present = values.filter((v): v is number => v !== null)
	return present.length ? round1(present.reduce((a, b) => a + b, 0) / present.length) : null
}

@Injectable()
export class PublicAnalyticsService {
	constructor(
		private readonly analytics: AnalyticsService,
		private readonly networks: NetworksService,
	) {}

	/** Public networks with their city, optionally of one city. */
	private publicNetworks(citySlug?: string) {
		const cities = this.networks
			.listCities(true)
			.filter((c) => citySlug === undefined || c.slug === citySlug)
		if (citySlug !== undefined && !cities.length)
			throw new GezcezError("NOT_FOUND", "City not found")
		return cities.map((city) => ({
			city,
			networks: this.networks
				.listNetworks({ cityId: city.id, publicOnly: true })
				.map((n) => ({
					network: n,
					bindingIds: this.networks.bindings(n.id).map((b) => b.id),
				})),
		}))
	}

	async quality(citySlug: string | undefined, days: number) {
		const groups = this.publicNetworks(citySlug)
		const now = Math.floor(Date.now() / 1000)
		let windowFrom = ""
		let windowTo = ""
		const cities = []
		for (const { city, networks } of groups) {
			const today = localTime(now, city.timezone).date
			const to = addDays(today, -1)
			const from = addDays(to, -(days - 1))
			windowFrom = windowFrom && windowFrom < from ? windowFrom : from
			windowTo = windowTo > to ? windowTo : to
			const out = []
			for (const { network, bindingIds } of networks) {
				const result = await this.analytics.run(
					"quality.feed",
					AnalyticsQuerySchema.parse({ from, to }),
					{ bindingIds, timezone: city.timezone },
				)
				// Several bindings per network: one score per day, the mean of the bindings.
				const byDate = new Map<string, Row[]>()
				for (const row of objects(result))
					byDate.set(row.date as string, [...(byDate.get(row.date as string) ?? []), row])
				const dayRows = [...byDate.entries()]
					.sort(([a], [b]) => (a < b ? -1 : 1))
					.map(([date, rows]) => ({
						date,
						score: mean(rows.map((r) => num(r.score))),
						success_rate: mean(rows.map((r) => num(r.success_rate))),
						lag_p95_s: mean(rows.map((r) => num(r.lag_p95_s))),
						coverage: mean(rows.map((r) => num(r.coverage))),
						gap_minutes: round1(
							rows.reduce((s, r) => s + (num(r.gap_minutes) ?? 0), 0),
						),
					}))
				out.push({
					id: network.slug,
					name: network.name,
					score: mean(dayRows.map((d) => d.score)),
					days: dayRows,
				})
			}
			cities.push({
				slug: city.slug,
				name: city.name,
				score: mean(out.map((n) => n.score)),
				networks: out,
			})
		}
		return { from: windowFrom, to: windowTo, cities }
	}

	private async fleetDay(bindingIds: number[], timezone: string, date: string) {
		const scope = { bindingIds, timezone }
		const daily = objects(
			await this.analytics.run(
				"fleet.hourly",
				AnalyticsQuerySchema.parse({ date, granularity: "1d" }),
				scope,
			),
		)[0]
		const hourly = objects(
			await this.analytics.run("fleet.hourly", AnalyticsQuerySchema.parse({ date }), scope),
		)
		return {
			date,
			vehicles: num(daily?.vehicles) ?? 0,
			peak_vehicles: num(daily?.peak_vehicles) ?? 0,
			vehicle_hours: num(daily?.vehicle_hours) ?? 0,
			hours: hourly.map(
				(r) =>
					[Number(String(r.bucket).slice(11, 13)), num(r.vehicles) ?? 0] as [
						number,
						number,
					],
			),
		}
	}

	async fleet(citySlug: string | undefined) {
		const now = Math.floor(Date.now() / 1000)
		const networks = []
		for (const { city, networks: list } of this.publicNetworks(citySlug)) {
			const today = localTime(now, city.timezone).date
			for (const { network, bindingIds } of list)
				networks.push({
					id: network.slug,
					name: network.name,
					city: city.slug,
					timezone: city.timezone,
					today: await this.fleetDay(bindingIds, city.timezone, today),
					yesterday: await this.fleetDay(bindingIds, city.timezone, addDays(today, -1)),
				})
		}
		return { generated_at: new Date().toISOString(), networks }
	}
}
