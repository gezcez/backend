// oauth.module.ts
// Authorization requests, token endpoint, revocation and logout. Provides BEARER_AUTH for the
// global AuthenticationGuard. Signing keys and the well-known documents are in KeysModule.

import { Global, Module } from "@nestjs/common"
import { BEARER_AUTH } from "@common/auth.types"
import { AuthorizeService } from "./authorize.service"
import { OAuthBearerAuth } from "./bearer-auth.provider"
import { ClientsService } from "./clients.service"
import { OAuthController } from "./oauth.controller"
import { OAuthRepository } from "./oauth.repository"
import { RefreshGraceService } from "./refresh-grace.service"
import { TokenController } from "./token.controller"
import { TokenService } from "./token.service"

@Global()
@Module({
	controllers: [OAuthController, TokenController],
	providers: [
		OAuthRepository,
		ClientsService,
		AuthorizeService,
		TokenService,
		RefreshGraceService,
		OAuthBearerAuth,
		{ provide: BEARER_AUTH, useExisting: OAuthBearerAuth },
	],
	exports: [ClientsService, TokenService, BEARER_AUTH],
})
export class OAuthModule {}
