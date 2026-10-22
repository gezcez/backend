// cards.service.ts
// Proxies card balance and history to the network's binding with the `card` capability. The
// card number is never stored or logged. No capable binding: CAPABILITY_UNSUPPORTED; killed:
// PROVIDER_DISABLED; upstream failure: PROVIDER_UNAVAILABLE; unknown number: CARD_NOT_FOUND.

import { Injectable, Logger } from "@nestjs/common"
import { GezcezError } from "@common/errors"
import { NetworksService } from "@services/networks/networks.service"
import { ProvidersRegistry } from "@services/providers/providers.registry"
import type { TransitProvider } from "@services/providers/transit-provider.interface"
import type { CardHistoryDto, CardLookupDto } from "./cards.dto"

const CARD_TIMEOUT_MS = 10_000
const HISTORY_MONTHS = 12

const iso = (s: number) => new Date(s * 1000).toISOString()

@Injectable()
export class CardsService {
	private readonly logger = new Logger("Cards")
	now: () => number = Date.now

	constructor(
		private readonly networks: NetworksService,
		private readonly providers: ProvidersRegistry,
	) {}

	private binding(networkRef: string, need: "balance" | "history") {
		const network = this.networks.network(networkRef)
		// Declared by the provider and not switched off on the binding (ignoring kill switches).
		const capable = this.networks.effectiveBindings(network.id).filter((e) => {
			const declared = this.providers.get(e.binding.provider_key)?.describe()
				.capabilities.card
			const override = (e.binding.capabilities as { card?: unknown } | null)?.card
			const card = override === null ? null : declared
			return !!card?.[need] && !card.requires_provider_account
		})
		if (!capable.length) throw new GezcezError("CAPABILITY_UNSUPPORTED")
		const effective = capable.find((e) => e.enabled && e.capabilities.card?.[need])
		if (!effective) throw new GezcezError("PROVIDER_DISABLED")
		const adapter = this.providers.get(effective.binding.provider_key)!
		return { adapter, context: this.networks.bindingContext(effective.binding.id) }
	}

	private validate(cardNumber: string, adapter: TransitProvider): void {
		const format = adapter.describe().capabilities.card?.number_format
		if (format && !new RegExp(format).test(cardNumber))
			throw new GezcezError("VALIDATION_FAILED", "card_number has the wrong format")
	}

	private async upstream<T>(call: (signal: AbortSignal) => Promise<T | null>): Promise<T> {
		let result: T | null
		try {
			result = await call(AbortSignal.timeout(CARD_TIMEOUT_MS))
		} catch (error) {
			this.logger.warn(`card upstream failed: ${(error as Error).message}`)
			throw new GezcezError("PROVIDER_UNAVAILABLE")
		}
		if (result === null) throw new GezcezError("CARD_NOT_FOUND")
		return result
	}

	async lookup(networkRef: string, cardNumber: string): Promise<CardLookupDto> {
		const { adapter, context } = this.binding(networkRef, "balance")
		this.validate(cardNumber, adapter)
		if (!adapter.cardBalance) throw new GezcezError("CAPABILITY_UNSUPPORTED")
		const lookup = adapter.cardBalance.bind(adapter)
		const balance = await this.upstream((signal) => lookup(context, cardNumber, signal))
		return {
			balance: balance.balance,
			currency: balance.currency,
			as_of: iso(balance.asOf),
			card_type: balance.cardType,
		}
	}

	async history(networkRef: string, cardNumber: string, month: string): Promise<CardHistoryDto> {
		const { adapter, context } = this.binding(networkRef, "history")
		this.validate(cardNumber, adapter)
		const now = new Date(this.now())
		const current = now.getUTCFullYear() * 12 + now.getUTCMonth()
		const [y, m] = month.split("-").map(Number)
		const asked = y! * 12 + (m! - 1)
		if (asked > current || current - asked >= HISTORY_MONTHS)
			throw new GezcezError(
				"VALIDATION_FAILED",
				`month must be within the last ${HISTORY_MONTHS}`,
			)
		if (!adapter.cardHistory) throw new GezcezError("CAPABILITY_UNSUPPORTED")
		const fetchHistory = adapter.cardHistory.bind(adapter)
		const history = await this.upstream((signal) =>
			fetchHistory(context, cardNumber, month, signal),
		)
		return {
			month,
			currency: history.currency,
			items: history.items
				.sort((a, b) => b.at - a.at)
				.map((t) => ({
					at: iso(t.at),
					kind: t.kind,
					amount: t.amount,
					balance_after: t.balanceAfter,
					route_short_name: t.routeShortName,
				})),
		}
	}
}
