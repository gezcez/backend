// oauth.controller.ts
import { Body, Controller, Get, Post, Req } from "@nestjs/common"
import { GezcezResponse } from "../../common/Gezcez"
import { OAuthDTO } from "./oauth.dto"

@Controller("oauth")
export class OAuthController {
	@Post("/login")
	async login(@Req() req:Request, @Body() form : OAuthDTO.LoginDto) {
		console.log(form.email)
		return GezcezResponse({ __message: "oauth home" })
	}
}
