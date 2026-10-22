// drizzle/imports-only
// This is a bun:sqlite project: only `drizzle-orm`, `drizzle-orm/sqlite-core`,
// `drizzle-orm/bun-sqlite` (and its migrator) and `drizzle-kit` (configs) may be imported.

const ALLOWED = new Set([
	"drizzle-orm",
	"drizzle-orm/sqlite-core",
	"drizzle-orm/bun-sqlite",
	"drizzle-orm/bun-sqlite/migrator",
	"drizzle-kit",
])

export default {
	meta: {
		type: "problem",
		docs: { description: "Only SQLite flavoured drizzle imports" },
		messages: {
			wrongDrizzleImport:
				"'{{source}}' is not allowed. Use drizzle-orm, drizzle-orm/sqlite-core or drizzle-orm/bun-sqlite.",
		},
		schema: [],
	},
	create(context) {
		return {
			ImportDeclaration(node) {
				const source = node.source.value
				if (typeof source !== "string") return
				if (!source.startsWith("drizzle-orm") && !source.startsWith("drizzle-kit")) return
				if (!ALLOWED.has(source)) {
					context.report({ node, messageId: "wrongDrizzleImport", data: { source } })
				}
			},
		}
	},
}
