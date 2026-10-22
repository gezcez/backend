// public.decorator.ts
// @Public() opts a route or controller out of the global authentication guard.

import { SetMetadata } from "@nestjs/common"

export const IS_PUBLIC_KEY = "gezcez:public"
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true)
