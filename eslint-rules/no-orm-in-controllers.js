// respect/no-orm-in-controllers
// Controllers and services work with repositories, never with drizzle or table objects:
// `drizzle-orm*` and `@schemas*` imports are forbidden in *.controller.ts and *.service.ts.

import { relativeFile, resolveModuleId } from "./module-path.js"

export default {
	meta: {
		type: "problem",
		docs: { description: "No drizzle-orm or schema imports in controllers and services" },
		messages: {
			noOrm: "'{{source}}' may not be imported in controllers or services; go through a repository.",
		},
		schema: [],
	},
	create(context) {
		const filename = context.filename ?? context.getFilename()
		const cwd = context.cwd ?? context.getCwd()
		const file = relativeFile(filename, cwd)
		if (!file.endsWith(".controller.ts") && !file.endsWith(".service.ts")) return {}
		return {
			ImportDeclaration(node) {
				const source = node.source.value
				if (typeof source !== "string") return
				// Type-only imports of table row types are fine.
				if (node.importKind === "type") return
				const id = resolveModuleId(source, filename, cwd)
				const isSchema =
					id !== null && (id === "src/schemas" || id.startsWith("src/schemas/"))
				const isOrm = source === "drizzle-orm" || source.startsWith("drizzle-orm/")
				if (isSchema || isOrm)
					context.report({ node, messageId: "noOrm", data: { source } })
			},
		}
	},
}
