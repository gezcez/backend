// cards.controller.ts
// POST /v1/networks/:networkId/cards/lookup and /cards/history (public, rate limited per IP).

import { Body, Controller, Header, HttpCode, Param, Post } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { ApiEnvelope, Public, RateLimit } from "@common/middlewares"
import { CardHistoryBodyDto, CardHistoryDto, CardLookupBodyDto, CardLookupDto } from "./cards.dto"
import { CardsService } from "./cards.service"

@ApiTags("transit: cards")
@Public()
@Controller("networks/:networkId/cards")
export class CardsController {
	constructor(private readonly cards: CardsService) {}

	@Post("lookup")
	@HttpCode(200)
	@RateLimit("cards")
	@Header("Cache-Control", "no-store")
	@ApiOperation({ summary: "Card balance by card number (capability card)" })
	@ApiEnvelope(CardLookupDto)
	lookup(@Param("networkId") networkId: string, @Body() body: CardLookupBodyDto) {
		return this.cards.lookup(networkId, body.card_number)
	}

	@Post("history")
	@HttpCode(200)
	@RateLimit("cards")
	@Header("Cache-Control", "no-store")
	@ApiOperation({ summary: "One month of card transactions (capability card)" })
	@ApiEnvelope(CardHistoryDto)
	history(@Param("networkId") networkId: string, @Body() body: CardHistoryBodyDto) {
		return this.cards.history(networkId, body.card_number, body.month)
	}
}
