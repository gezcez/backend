// oauth.controller.ts
import {
	Body,
	Controller,
	Post,
	Get,
	Query,
	Req,
	UseGuards,
	Res,
	HttpStatus,
	HttpException,
	Param,
} from "@nestjs/common"
import { OAuthService } from "./oauth.service"
import { OAuthDTO } from "./oauth.dto"

import { GezcezResponse } from "../../common/Gezcez"
import { AuthenticationGuard } from "../../guards/authentication.guard"
import { AuthorizationGuard } from "../../guards/authorization.guard"
import { GezcezError } from "../../common/GezcezError"
import { Response } from "express"

@Controller("oauth")
export class OAuthController {
	
}
