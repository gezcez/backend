// Shared helpers for the custom rules: resolve an import specifier to a repo-relative module id
// (aliases from tsconfig.json and relative paths), so rules match modules, not substrings.

import path from "node:path"

const ALIASES = [
	["@common/", "src/common/"],
	["@db/", "src/db/"],
	["@schemas/", "src/schemas/"],
	["@services/", "src/services/"],
	["@ws/", "src/ws/"],
	["@test/", "test/"],
]
const EXACT = {
	"@db": "src/db/index.ts",
	"@schemas": "src/schemas/index.ts",
	"@lang": "src/lang/index.ts",
}

/** Returns a POSIX path relative to the repo root, or null for packages. */
export function resolveModuleId(specifier, filename, cwd) {
	if (EXACT[specifier]) return EXACT[specifier]
	for (const [prefix, target] of ALIASES) {
		if (specifier.startsWith(prefix)) return target + specifier.slice(prefix.length)
	}
	if (specifier.startsWith(".")) {
		const absolute = path.resolve(path.dirname(filename), specifier)
		return path.relative(cwd, absolute).split(path.sep).join("/")
	}
	return null
}

export function relativeFile(filename, cwd) {
	return path.relative(cwd, filename).split(path.sep).join("/")
}
