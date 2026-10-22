// public.decorator.ts
// @Public() opts a route or controller out of the global authentication guard.

import { SetMetadata } from "@nestjs/common"
import { AUTH_KIND_KEY } from "@common/auth.types"

export const Public = () => SetMetadata(AUTH_KIND_KEY, "public")
