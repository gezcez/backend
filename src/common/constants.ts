// constants.ts
// Values shared by the app factory and code that needs to know public paths.

export const API_PREFIX = "v1"

/**
 * Longest access token lifetime any app may have. The revoked-sid set keeps entries this long
 * (plus skew), so a revoked session's tokens can never outlive it.
 */
export const MAX_ACCESS_TTL_S = 3600
