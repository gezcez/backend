import { Elysia, t } from "elysia"
import { OAuthDTO } from "./oauth.dto"
import {
	GezcezError,
	GezcezValidationFailedError,
} from "../../common/GezcezError"
import { OAuthService } from "./oauth.service"
import { GezcezResponse } from "../../common/Gezcez"
import { OAuthRepository } from "./oauth.repository"
import { SignJWT } from "jose"

import { appsTable } from "../../schema/apps"
import { db } from "../../util"
import { and, eq } from "drizzle-orm"
import { AuthenticationMiddleware } from "../../middlewares/authentication.middleware"
import { UserRepository } from "../user/user.repository"
import { usersTable } from "../../schema/users"
import { AppsRepository } from "../apps/apps.repository"
import { AuthorizationMiddleware } from "../../middlewares/authorization.middleware"
import {
	permissionsTable,
	userPermissionsTable,
} from "../../schema/permissions"
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
			c.set.status = 409
			if (error) return GezcezResponse({ __message: error }, 409)

			return GezcezResponse(
				{
					account: { ...user, password: undefined },
					__message:
						"Account has been created successfully! [email verification needed].",
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
			.use(
				AuthenticationMiddleware({
					aud: "oauth",
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
						return GezcezError("UNAUTHORIZED",{__message:`You do not have access to app '${app_key}'`})
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
						is_activated: user.is_activated,
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
