// respect/repositories-only
// Only repositories touch the database: importing the database module (`@db`, `src/db/*`) is
// allowed in *.repository.ts, src/db/**, src/app.module.ts, src/tracker.worker.ts (composition roots), scripts/**, test/** and specs only.
// Legacy matched the substring "db" in any import path; this resolves the module id instead.

import { relativeFile, resolveModuleId } from "./module-path.js"

function isAllowedFile(file) {
	return (
		file.endsWith(".repository.ts") ||
		file.endsWith(".spec.ts") ||
		file.startsWith("src/db/") ||
		file === "src/app.module.ts" ||
		file === "src/tracker.worker.ts" ||
		file.startsWith("scripts/") ||
		file.startsWith("test/")
	)
}

function isDbModule(id) {
	return id === "src/db" || id.startsWith("src/db/")
}

export default {
	meta: {
		type: "problem",
		docs: { description: "Only repositories may import the database module" },
		messages: {
			noDbImport:
				"Importing the database module is only allowed in *.repository.ts files (found '{{source}}').",
		},
		schema: [],
	},
	create(context) {
		const cwd = context.cwd ?? context.getCwd()
		const file = relativeFile(context.filename ?? context.getFilename(), cwd)
		if (isAllowedFile(file)) return {}
		const check = (node, source) => {
			if (typeof source !== "string") return
			const id = resolveModuleId(source, context.filename ?? context.getFilename(), cwd)
			if (id && isDbModule(id))
				context.report({ node, messageId: "noDbImport", data: { source } })
		}
		return {
			ImportDeclaration(node) {
				check(node, node.source.value)
			},
			ExportNamedDeclaration(node) {
				if (node.source) check(node, node.source.value)
			},
			ExportAllDeclaration(node) {
				check(node, node.source.value)
			},
			ImportExpression(node) {
				if (node.source.type === "Literal") check(node, node.source.value)
			},
		}
	},
}
