import { IsArray, IsEnum, IsIn, IsInt, ValidateNested } from "class-validator"
import { ApiProperty } from "@nestjs/swagger"
import { Type } from "class-transformer"

export namespace DashboardModels {
	export class WritePermissionsToRoleDTO {
		@ApiProperty({ name: "role_id", type: "integer", example: 1, description: "Role id to add permission to" })
		@IsInt()
		role_id: number

		@ApiProperty({
			name: "operations",
			type: "array",
			example: [
				{ permission_id: 1, operation_type: "add" },
				{ permission_id: 2, operation_type: "remove" },
			],
			description: "List of operations to perform",
		})
		@IsArray()
		@ValidateNested({ each: true })
		@Type(() => WritePermissionOperationDTO)
		operations: WritePermissionOperationDTO[]
	}

	export class WriteRolesToUserDTO {
		@ApiProperty({ name: "user_id", type: "integer", example: 1, description: "User id to modify roles for" })
		@IsInt()
		user_id: number

		@ApiProperty({
			name: "operations",
			type: "array",
			example: [
				{ role_id: 1, operation_type: "add" },
				{ role_id: 2, operation_type: "remove" },
			],
			description: "List of role operations to perform",
		})
		@IsArray()
		@ValidateNested({ each: true })
		@Type(() => WriteRoleOperationDTO)
		operations: WriteRoleOperationDTO[]
	}

	export class CheckUserEditPermissionDTO {
		@ApiProperty({ name: "user_id", type: "integer", example: 1, description: "User id to check edit permission for" })
		@IsInt()
		user_id: number
	}
}

class WritePermissionOperationDTO {
	@ApiProperty({name:"permission_id",description:"Permission id to perform given operation"})
	@IsInt()
	permission_id: number

	@ApiProperty({name:"operation_type",description:"Operation type to perform",examples:["add","remove"]})
	@IsIn(["add", "remove"])
	operation_type: "add" | "remove"
}

class WriteRoleOperationDTO {
	@ApiProperty({name:"role_id",description:"Role id to perform given operation"})
	@IsInt()
	role_id: number

	@ApiProperty({name:"operation_type",description:"Operation type to perform",examples:["add","remove"]})
	@IsIn(["add", "remove"])
	operation_type: "add" | "remove"
}
