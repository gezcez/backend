// scopes.ts
// OAuth scopes (plan section 6.1.3). i18n keys are translated by the clients.

export const SCOPES = {
	openid: { i18n_key: "scope.openid" },
	profile: { i18n_key: "scope.profile" },
	email: { i18n_key: "scope.email" },
	offline_access: { i18n_key: "scope.offline_access" },
	dash: { i18n_key: "scope.dash" },
	transit: { i18n_key: "scope.transit" },
	cards: { i18n_key: "scope.cards" },
} as const

export type Scope = keyof typeof SCOPES
export const SCOPE_KEYS = Object.keys(SCOPES) as Scope[]

export function isScope(value: string): value is Scope {
	return value in SCOPES
}

export function parseScope(value: string | undefined | null): string[] {
	return [...new Set((value ?? "").split(" ").filter(Boolean))]
}

export function formatScope(scopes: Iterable<string>): string {
	return [...new Set(scopes)].join(" ")
}
