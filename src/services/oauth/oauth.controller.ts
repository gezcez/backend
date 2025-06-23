import { Elysia, t } from "elysia"
import { OAuthDTO } from "./oauth.dto"
import { GezcezValidationFailedError } from "../../common/GezcezError"
import { OAuthService } from "./oauth.service"
import { GezcezResponse } from "../../common/Gezcez"
export const OAuthController = new Elysia({
	prefix: "/oauth",
	name: "oauth.controller.ts",
	tags: ["OAuth Service"],

}).group("/account",
	(group) => group.post("create", async (c) => {
		const { body } = c
		const { email, password, tos, username } = body
		if (!(tos === true)) return GezcezValidationFailedError(c, "body:tos", "user must accept tos!")
		if (!OAuthService.validate("username", username)) {
			return GezcezValidationFailedError(c, "body:username", "Username must only contain numbers, lowercase and uppercase letters.")
		}
		if (!OAuthService.validate("password", password)) {
			return GezcezValidationFailedError(c, "body:password", `Password must be between 6 and 128 characters long`)
		}
		if (!OAuthService.validate("email", email)) {
			return GezcezValidationFailedError(c, "body:password", "invalid email!")
		}
		const [user, error] = await OAuthService.insertUser({
			email: email, username: username, password: password
		})
		c.set.status=409
		if (error) return GezcezResponse({ __message: error }, c, 409)
		return GezcezResponse({ account: { ...user, password: undefined }, __message: "Account has been created successfully! [email verification needed]." }, c, 200)
	}, { body: OAuthDTO.account_create })
)
