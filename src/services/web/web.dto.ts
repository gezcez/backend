import { ApiProperty } from "@nestjs/swagger";
import { IsArray, IsInt, IsObject, IsString } from "class-validator";

export namespace WebModels {

	export class OptOutDto {

		@ApiProperty({
			description:"Çıkılmak istenen kart no",
			examples:["01234567890","?"],
			required:true
		})
		@IsString()
		card_no:string

		@ApiProperty({
			description:"Çıkılmak istenen özellikler",
			required:true,
			example:["card_images","card_transactions"]
		})
		@IsArray({
			message:"features kısmı string[] tipine uymalıdır. çıkılabilecek özellikleri görmek için /privacy/data-providers endpoint'ine bakın",
		})
		features:string[]
	}
}