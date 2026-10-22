// public-id.utils.ts
// Stable public ids for routes, stops and vehicles: `<binding_id>.<external_id>` (plan 7.0).

export function publicRef(bindingId: number, externalId: string): string {
	return `${bindingId}.${externalId}`
}

export interface ParsedRef {
	bindingId: number
	externalId: string
}

export function parsePublicRef(value: string): ParsedRef | null {
	const match = /^(\d{1,9})\.(.{1,64})$/.exec(value)
	if (!match) return null
	return { bindingId: Number(match[1]), externalId: match[2]! }
}
