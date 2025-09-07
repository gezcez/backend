// oauth.controller.ts

import {
	Body,
	Controller,
	Get,
	Post,
	Query,
	Req,
	UseGuards,
} from "@nestjs/common"
import type { Request } from "express"
import { ApiHeader } from "@nestjs/swagger"
import { eq } from "drizzle-orm"
import { JWTPayload, jwtVerify, SignJWT } from "jose"
import { AppsRepository } from "../web/repositories/apps.repository"
import { EmailRepository } from "../email/email.repository"
import { EmailService } from "../email/email.service"
import { UserRepository } from "../user/user.repository"
import { OAuthDTO } from "./oauth.dto"
import { OAuthRepository } from "./oauth.repository"
import { OAuthService } from "./oauth.service"
import { moderationLogs, refreshTokensTable, usersTable } from "@schemas"
import { OAuthUtils, RoleUtils, secret_random } from "@common/utils"
import { AuthenticationGuard, UseAuthorization } from "@common/middlewares"
import { GezcezError, GezcezResponse, GezcezValidationFailedError } from "@gezcez/core"
@Controller("oauth")
export class OAuthController {
	
	@ApiHeader({
		name: "Authorization",
		description: "Bearer token",
		required: true,
	})
	@UseGuards(
		AuthenticationGuard({ app_key: "oauth", is_use_refresh_token: true })
	)
	@Post("/logout")
	async logout(@Req() req: Request) {
		const payload = req["payload"]!
		const result = await OAuthRepository.invalidateRefreshToken(payload.jti,payload.sub)
		if (!result) return GezcezError("INTERNAL_SERVER_ERROR", { __message: "Logout failed" })
		return GezcezResponse({ __message: "Logout successful" })
	}

	@Post("/login")
	async login(@Req() req: Request, @Body() form: OAuthDTO.LoginDto) {
		const { email, password } = form
		const user = await OAuthRepository.getUserByEmailAndPassword(email, password)
		if (!user) {
			return GezcezResponse({ __message: "Invalid email or password!" }, 401)
		}
		if (user.ban_record) {
			const ban_details = await UserRepository.getUserBanRecordFromRecordId(user.ban_record)
			return GezcezResponse(
				{
					__message: "Hesabınız karalisteye alınmış.",
					ban_data: {
						...ban_details,
						private_reason: undefined,
						public_reason: undefined,
						reason: ban_details.public_reason,
						id: undefined,
						created_by: undefined,
						args: undefined,
					},
				},
				403
			)
		}
		if (!user.activated_at) {
			return GezcezResponse(
				{
					__message:
						"email'inize gönderdiğimiz linke tıklayarak hesabınızı doğrulamanız gerekli.",
					resend: true,
				},
				403
			)
		}
		const jti = crypto.randomUUID()
		const token = await OAuthUtils.signJWT(
			{
				sub: user.id.toString(),
				is_activated: !!user.activated_at,
				jti: jti,
				type: "refresh",
			},
			"15d",
			"oauth"
		)
		const result = await OAuthRepository.insertRefreshToken(user.id, jti)
		if (!result)
			return GezcezError("INTERNAL_SERVER_ERROR", {
				__message: `Giriş işleminizi gerçekleştirirken bir hata ile karşılaştık. (refresh_token_insert_failed)`,
			})
		return GezcezResponse({
			user: user,
			refresh_token: token,
		})
	}

	@ApiHeader({
		name: "Authorization",
		description: "Bearer token",
		required: true,
	})
	@UseGuards(
		AuthenticationGuard({ app_key: "oauth", is_use_refresh_token: true })
	)
	@Post("/account/authorize")
	async authorize(@Req() req: Request, @Body() form: OAuthDTO.AuthorizeDto) {
		const { app_key } = form
		const payload = req["payload"]!
		const app_details = await AppsRepository.getAppByKey(app_key)
		if (!app_details) return GezcezError("BAD_REQUEST", {__message:"app not found"})
		const is_valid = await OAuthRepository.isJWTValid(payload.jti, payload.sub)
		if (!is_valid) return GezcezError("UNAUTHORIZED", {__message:"Token is invalidated"})
		const user_permissions = await UserRepository.getUserPermissionsByAppKey(
			payload.sub,
			app_key
		)
		const user_roles = await UserRepository.listUserRoles(payload.sub)
		const networks = [...new Set(user_roles.map((e) => e.network_id))]
		const roles_payload: Record<string, number> = {}
		for (const network of networks) {
			const value = RoleUtils.getValueFromRoles(
				user_roles.filter((e) => e.network_id === network)
			)
			roles_payload[`${network === 0 ? "_" : network}`] = value
		}
		const scope_payload = new Map()
		for (const permission of user_permissions) {
			const user_p = permission.user_permission
			const details = permission.permission_details
			const scope = (user_p.network_id||"_").toString()
			const current_value = scope_payload.get(scope) || 0
			if (user_p.status === true) {
				scope_payload.set(scope, current_value + 2 ** user_p.permission_id)
			}
		}
		const payload_o = Object.fromEntries(scope_payload.entries())
		// if (Object.keys(payload_o).length <= 0) {
		// 	return GezcezError("FORBIDDEN", {
		// 		__message: `You do not have access to app '${app_key}'`,
		// 	})
		// }
		const refresh_token = await OAuthUtils.signJWT(
			{
				scopes: payload_o,
				roles: roles_payload,
				sub: payload.sub.toString(),
				is_activated: payload.is_activated,
				type:"refresh",
				parent: payload.jti,
			},
			"4h",
			app_key
		)
		return GezcezResponse(
			{
				__message: "Logged in!",
				app:app_key,
				token: refresh_token,
				redirect_uri: app_details.oauth_callback_url ? `${app_details.oauth_callback_url}?_=${refresh_token}` : null,
				scopes: payload_o,
				roles: roles_payload,
				type:"refresh"
			},
			200
		)
	}


	@Get("/account/get-apps")
	async getApps(@Req() req: Request) {
		const apps = (await AppsRepository.list()).map((app)=>{
			return {
				key:app.key,
				name:app.name,
				redirect_uri:app.oauth_callback_url,
			}
		})
		return GezcezResponse({ apps }, 200)
	}

	@Get("/account/activate")
	async activate(@Req() req: Request, @Query() _: OAuthDTO.ActivateDto) {
		const secret = secret_random
		if (!secret)
			return GezcezError("INTERNAL_SERVER_ERROR", {
				__message:
					"İşleminizi gerçekleştiremiyoruz. biri JWT secret'ı .env'a koymayı unutmuş." +
					"\nbu hatayı görüyorsanız lütfen iletişime geçin: wemessedup@gezcez.com",
			})
		const token = _._
		let payload: { email_id: string } & JWTPayload
		try {
			payload = (
				await jwtVerify(token, secret, {
					audience: "activation.emails",
				})
			).payload as any
		} catch {
			return "Linkin süresi dolmuş, geçerli değil veya "
		}
		if (!payload) return "Linkin süresi dolmuş, geçerli değil veya "
		const uuid = payload.email_id
		if (!uuid) return "uuid is undefined"
		const [email, email_error] = await EmailRepository.selectEmailById(uuid)
		if (!email || email_error) {
			return "Link geçerli fakat veri tabanında email bulunamadı."
		}
		const user = await OAuthRepository.getUserById(payload.sub as string, {
			get_raw_email: true,
			get_raw_password: false,
		})
		if (!user) return "Link geçerli fakat kullanıcı silinmiş."
		if (user.activated_at) return "Hesap zaten aktif edilmiş."
		
		return "Hesap başarıyla aktif edildi!"
	}


	@Post("/account/create")
	async create(@Req() req: Request, @Body() body: OAuthDTO.CreateAccountDto) {
		const { email, password, tos, username } = body
		if (!(tos === true))
			return GezcezValidationFailedError("body:tos", "user must accept tos!")
		if (!OAuthUtils.validate("username", username)) {
			return GezcezValidationFailedError(
				"body:username",
				"Username must only contain numbers, lowercase and uppercase letters."
			)
		}
		if (!OAuthUtils.validate("password", password)) {
			return GezcezValidationFailedError(
				"body:password",
				`Password must be between 6 and 128 characters long`
			)
		}
		if (!OAuthUtils.validate("email", email)) {
			return GezcezValidationFailedError("body:password", "invalid email!")
		}
		const [user, error] = await OAuthRepository.insertUser({
			email: email,
			username: username,
			password: password,
		})
		if (error) {
			return GezcezResponse({ __message: error }, 500)
		}
		if (!user) {
			return GezcezResponse({ __message: "An account with this email or username already exists" }, 409)
		}
		const id = crypto.randomUUID()
		const token = await new SignJWT({
			aud: "activation.emails",
			email_id: id,
		})
			.setProtectedHeader({
				alg: "HS256",
			})
			.setSubject(user.id.toString())
			.setJti(crypto.randomUUID())
			.setIssuer("oauth.gezcez.com")
			.setExpirationTime("6h")
			.sign(secret_random)
		function build_content(token: string) {
			return `https://api.gezcez.com/oauth/account/activate?_=${token}`
		}
		const [email_row, email_error] = await EmailService.sendEmail(
			{
				content: build_content(token),
				type: "activation",
				target_user_id: user.id,
				uuid: id,
			},
			id
		)
		if (!email_row || email_error) {
			return GezcezResponse(
				{
					__message:
						(email_error as string) || "unknown error occured during email request",
				},
				500
			)
		}
		return GezcezResponse(
			{
				__debug:
					process.env.NODE_ENV === "dev"
						? { email: email_row, link: build_content(token) }
						: undefined,
				account: { ...user, password: undefined },
				__message:
					"Please verify your account using the link we've sent to your email adress",
			},
			200
		)
	}

	@ApiHeader({
		name: "Authorization",
		description: "Bearer token",
		required: true,
	})
	@UseGuards(AuthenticationGuard({
		is_use_refresh_token:true,
		app_key:"inherit",
	}))
	@Post("/account/access")
	async accessApp(@Req() req:Request, @Body() body: OAuthDTO.AuthorizeDto) {
		const { app_key } = body
		const payload = req["payload"]!
		const app_details = await AppsRepository.getAppByKey(app_key)
		if (!app_details) return GezcezError("BAD_REQUEST", "app not found")
		const user_permissions = await UserRepository.getUserPermissionsByAppKey(
			payload.sub,
			app_key
		)
		if (! (app_key === payload.aud)) {
			return GezcezError("FORBIDDEN",{__message:"JWT audience does not match app_key provided in the body"})
		}
		if (!payload.parent) {
			return GezcezError("FORBIDDEN",{__message:"This endpoint only accepts refresh tokens (parent missing)"})
		}
		if (process.env.NODE_ENV === "production") {
			const is_valid = await OAuthRepository.isJWTValid(payload.parent, payload.sub)
			if (!is_valid) return GezcezError("UNAUTHORIZED", {__message:"Token is invalidated"})
		}
		const user_roles = await UserRepository.listUserRoles(payload.sub)
		const networks = [...new Set(user_roles.map((e) => e.network_id))]
		const roles_payload: Record<string, number> = {}
		for (const network of networks) {
			const value = RoleUtils.getValueFromRoles(
				user_roles.filter((e) => e.network_id === network)
			)
			roles_payload[`${network === 0 ? "_" : network}`] = value
		}
		const scope_payload = new Map()
		for (const permission of user_permissions) {
			const user_p = permission.user_permission
			const details = permission.permission_details
			const scope = (user_p.network_id||"_").toString()
			const current_value = scope_payload.get(scope) || 0
			if (user_p.status === true) {
				scope_payload.set(scope, current_value + 2 ** user_p.permission_id)
			}
		}
		const payload_o = Object.fromEntries(scope_payload.entries())
		// if (Object.keys(payload_o).length <= 0) {
		// 	return GezcezError("FORBIDDEN", {
		// 		__message: `You do not have access to app '${app_key}'`,
		// 	})
		// }
		const access_token = await OAuthUtils.signJWT(
			{
				scopes: payload_o,
				roles: roles_payload,
				sub: payload.sub.toString(),
				is_activated: payload.is_activated,
				type:"access",
				parent: payload.jti,
			},
			"15m",
			app_key
		)
		return GezcezResponse(
			{
				app:app_key,
				token: access_token,
				scopes: payload_o,
				roles: roles_payload,
				type:"access",
				parent:payload.jti
			},
			200
		)
	}
}
