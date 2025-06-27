import { IsEmail, IsString, IsBoolean } from "class-validator"

export namespace OAuthDTO {
	export class CreateAccountDto {
		@IsEmail()
		email: string

		@IsString()
		password: string

		@IsBoolean()
		tos: boolean

		@IsString()
		username: string
	}

	export class LoginDto {
		@IsEmail()
		email: string

		@IsString()
		password: string
	}
}
