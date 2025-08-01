import { ApiProperty } from "@nestjs/swagger"
import { IsEmail, IsString, IsBoolean, IsEnum } from "class-validator"

export namespace OAuthDTO {
	export class CreateAccountDto {
		@ApiProperty({
			description: "email of the user",
			example: "jack.sparrow@gezcez.com",
		})
		@IsEmail()
		email: string

		@ApiProperty({ description: "password of the user", example: "A0F!%6(.KV" })
		@IsString()
		password: string

		@ApiProperty({
			description: "user must accept TOS to use gezcez.com's services",
			example: true,
		})
		@IsBoolean()
		tos: boolean

		@ApiProperty({
			description: "publicly visible username",
			example: "captain.jack",
		})
		@IsString()
		username: string
	}

	export class LoginDto {
		@ApiProperty({
			description: "email of the user",
			example: "jack.sparrow@gezcez.com",
		})
		@IsEmail()
		email: string

		@ApiProperty({ description: "password of the user", example: "A0F!%6(.KV" })
		@IsString()
		password: string
	}

	export class AuthorizeDto {
		@ApiProperty({ description: "app name to authorize", example: "system" })
		// @IsEnum(["system", "oauth", "dashboard", "mobile"],{message:(args)=>`Invalid app_key`})
		@IsString()
		app_key: string
	}

	export class ActivateDto {
		@ApiProperty({ description: "activation token sent to email" })
		@IsString()
		_: string
	}
}
