// dash.models.ts
// Small reference shapes shared by dashboard responses (component names match the dashboard's
// generated types).

import { z } from "zod"
import { ErrorCodeSchema } from "../response"

/** Without an id, for DTO classes named UserRef (a DTO root must not carry a schema id). */
export const UserRefBase = z.object({
	/** public_id */
	id: z.string(),
	display_name: z.string(),
	username: z.string().nullable(),
})
export const UserRefSchema = UserRefBase.meta({ id: "UserRef" })
export type UserRef = z.infer<typeof UserRefSchema>

export const NetworkRefSchema = z
	.object({ id: z.number().int(), slug: z.string(), name: z.string() })
	.meta({ id: "NetworkRef" })
export type NetworkRef = z.infer<typeof NetworkRefSchema>

export const ReasonSchema = z.object({ reason: z.string().trim().min(3).max(500) })

/** Batch role edits from the member and user role editors. */
export const RoleOperationsSchema = z.object({
	operations: z
		.array(z.object({ role_id: z.number().int(), op: z.enum(["grant", "revoke"]) }))
		.min(1)
		.max(50),
})

export const DateTime = z.iso.datetime()

/** ErrorCode as a named component, for error codes inside success bodies (batch results). */
export const ErrorCodeRef = ErrorCodeSchema.meta({ id: "ErrorCode" })
