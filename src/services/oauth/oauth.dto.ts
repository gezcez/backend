import { t } from "elysia"
import { config } from "../../util"
export abstract class OAuthDTO {
	static account_create = t.Object({
		username: t.String({
			minLength: config.validation.username.min_length,
			maxLength: config.validation.username.max_length,
			examples: ["john_smith"],
			description: "Username for the account",
			error: `Username must be between ${config.validation.username.min_length} and ${config.validation.username.max_length} characters long`

		}),
		email: t.String({
			minLength: config.validation.email.min_length,
			maxLength: config.validation.email.max_length,
			format: "email",
			examples: ["john.s@gezcez.com"],
			description: "email for the account",
			error: "invalid email!"
		}
		),
		password: t.String({
			minLength: config.validation.password.min_length,
			maxLength: config.validation.password.max_length,
			examples: ["uIIY8u{#m2["],
			description: "Password for the account",
			error: "aaa"
		}),
		tos: t.Boolean({
			description: "User must accept terms of service to create account",
			default: false,
			examples: [false],
			error: "User must accept terms of service to create account"
		})
	},
	)
	static account_login = t.Omit(
		OAuthDTO.account_create,
		["tos", "username"]
	)
}