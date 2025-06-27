import { Elysia, t } from "elysia"
import { JWTPayload, jwtVerify, SignJWT } from "jose"
import { GezcezResponse } from "../../common/Gezcez"
import {
	GezcezError,
	GezcezValidationFailedError,
} from "../../common/GezcezError"
import { OAuthDTO } from "./oauth.dto"
import { OAuthRepository } from "./oauth.repository"
import { OAuthService, secret_random } from "./oauth.service"

import { AuthenticationMiddleware } from "../../middlewares/authentication.middleware"
import { AuthorizationMiddleware } from "../../middlewares/authorization.middleware"
import { AppsRepository } from "../apps/apps.repository"
import { EmailService } from "../email/email.service"
import { UserRepository } from "../user/user.repository"
import { EmailRepository } from "../email/email.repository"
import { db } from "../../util"
import { usersTable } from "../../schema/users"
import { eq } from "drizzle-orm"
import { RatelimitterMiddleware } from "../../middlewares/ratelimitter.middleware"
export const OAuthController = new Elysia({
	prefix: "/oauth",
	name: "oauth.controller.ts",
	tags: ["OAuth Service"],
})
	.post(
		"/create",
		async (c) => {
			const { body } = c
			const { email, password, tos, username } = body
			if (!(tos === true))
				return GezcezValidationFailedError(c, "body:tos", "user must accept tos!")
			if (!OAuthService.validate("username", username)) {
				return GezcezValidationFailedError(
					c,
					"body:username",
					"Username must only contain numbers, lowercase and uppercase letters."
				)
			}
			if (!OAuthService.validate("password", password)) {
				return GezcezValidationFailedError(
					c,
					"body:password",
					`Password must be between 6 and 128 characters long`
				)
			}
			if (!OAuthService.validate("email", email)) {
				return GezcezValidationFailedError(c, "body:password", "invalid email!")
			}
			const [user, error] = await OAuthRepository.insert({
				email: email,
				username: username,
				password: password,
			})
			if (error || !user) {
				c.set.status = 409
				return GezcezResponse({ __message: error }, 409)
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
				c.set.status = 500
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
		},
		{
			body: OAuthDTO.account_create,
		}
	)

	.group("/account", (app) =>
		app
			.get(
				"/activate",
				async ({ query: { _ } }) => {
					const secret = secret_random
					if (!secret)
						return GezcezError("INTERNAL_SERVER_ERROR", {
							__message:
								"İşleminizi gerçekleştiremiyoruz. biri JWT secret'ı .env'a koymayı unutmuş." +
								"\nbu hatayı görüyorsanız lütfen iletişime geçin: wemessedup@gezcez.com",
						})
					const token = _
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
					const user = await OAuthRepository.selectUserById(payload.sub as string, {
						get_raw_email: true,
						get_raw_password: false,
					})
					if (!user) return "Link geçerli fakat kullanıcı silinmiş."
					if (user.activated_at) return "Hesap zaten aktif edilmiş."
					const [updated_user] = await db
						.update(usersTable)
						.set({
							activated_at: new Date(),
						})
						.where(eq(usersTable.id, user.id))
						.returning()
					return "Hesap başarıyla aktif edildi!"
				},
				{
					query: t.Object({
						_: t.String(),
					}),
				}
			)
			.use(
				AuthenticationMiddleware({
					aud: "oauth",
				})
			)
			.get("/me", async ({ payload }) => {
				const user = await OAuthRepository.selectUserById(payload.sub, {
					get_raw_email: true,
				})
				// const permissions = await UserRepository.getUserPermissions(payload.sub)
				return GezcezResponse({
					payload: payload,
					account: user,
					// permissions: permissions,
				})
			})
			.use(
				RatelimitterMiddleware({
					allowed_rpm: 10,
					app_key: "oauth",
					block_for_seconds: 60,
					key_getter: (c: any) => {
						if (c?.payload) return `${c?.payload?.sub}`
						return
					},
				})
			)
			.post(
				"/authorize",
				async ({ payload, query: { app_key } }) => {
					const app_details = await AppsRepository.getAppByKey(app_key)
					if (!app_details) return GezcezError("BAD_REQUEST", "app not found")
					const user_permissions = await UserRepository.getUserPermissionsByAppKey(
						payload.sub,
						app_key
					)
					const scope_payload = new Map()
					for (const permission of user_permissions) {
						const user_p = permission.user_permission
						const details = permission.permission_details
						const scope = details?.type === "scoped" ? user_p.network_id.toString() : "_"
						const current_value = scope_payload.get(scope) || 0
						if (user_p.status === true) {
							scope_payload.set(scope, current_value + 2 ** user_p.permission_id)
						}
					}
					const payload_o = Object.fromEntries(scope_payload.entries())
					if (Object.keys(payload_o).length <= 0) {
						return GezcezError("UNAUTHORIZED", {
							__message: `You do not have access to app '${app_key}'`,
						})
					}
					const access_token = await OAuthService.signJWT(
						{
							scopes: payload_o,
							sub: payload.sub.toString(),
							is_activated: payload.is_activated,
						},
						"1h",
						"system"
					)
					return GezcezResponse(
						{ __message: "Logged in!", access_token: access_token, payload: payload_o },
						200
					)
				},
				{ query: t.Object({ app_key: t.String() }) }
			)
			.use(
				AuthorizationMiddleware({
					app_key: "oauth",
					permission_id: 1,
					scope: "global",
				}).get("/list-user-permissions", async ({ payload }) => {
					return GezcezResponse({
						permissions: await UserRepository.getUserPermissions(payload.sub),
					})
					// adding ability to list users is ALWAYS a bad choice!!!
				})
			)
	)
	.post(
		"/login",
		async ({ body: { email, password }, set }) => {
			const user = await OAuthRepository.selectUserByEmailAndPassword(email, password)
			if (!user) {
				set.status = 401
				return GezcezResponse({ __message: "Invalid email or password!" }, 401)
			}
			return GezcezResponse({
				user: user,
				refresh_token: await OAuthService.signJWT(
					{
						sub: user.id.toString(),
						is_activated: !!user.activated_at,
						jti: crypto.randomUUID(),
					},
					"15d",
					"oauth"
				),
			})
		},
		{
			body: OAuthDTO.account_login,
		}
	)
