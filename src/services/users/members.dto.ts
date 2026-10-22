// members.dto.ts
// Network members (plan 6.3): users holding a role in the network, emails masked.

import { z } from "zod"
import { DateTime, UserRefBase, UserRefSchema } from "@common/models/dash.models"
import { pageSchema, PageQuerySchema, zodDto } from "@common/response"
import { RoleRefBase, RoleRefSchema } from "@services/roles/roles.dto"

export const MemberSchema = z
	.object({
		user: UserRefSchema,
		email_masked: z.string(),
		last_active_at: DateTime.nullable(),
		roles: z.array(
			z.object({
				role: RoleRefSchema,
				granted_at: DateTime,
				granted_by: UserRefSchema.nullable(),
			}),
		),
	})
	.meta({ id: "Member" })

export class MemberPageDto extends zodDto(pageSchema(MemberSchema)) {}

export class MemberQueryDto extends zodDto(
	PageQuerySchema.extend({ role: z.string().max(32).optional() }),
) {}

export class CandidateQueryDto extends zodDto(
	z.object({ q: z.string().trim().max(200).default("") }),
) {}

/** Named after the components. */
export class UserRef extends zodDto(UserRefBase) {}
export class RoleRef extends zodDto(RoleRefBase) {}
