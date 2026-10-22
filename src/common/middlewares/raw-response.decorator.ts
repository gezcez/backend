// raw-response.decorator.ts
// Opts a route out of the `{ ok, data }` envelope. Only for RFC shaped endpoints (token, revoke,
// .well-known) and the OpenAPI document.

import { SetMetadata } from "@nestjs/common"

export const RAW_RESPONSE_KEY = "gezcez:raw-response"
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true)
