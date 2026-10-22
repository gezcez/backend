import { describe, test } from "bun:test"
import { RuleTester } from "eslint"
import path from "node:path"
import drizzleImportsOnly from "./drizzle-imports-only.js"
import noOrmInControllers from "./no-orm-in-controllers.js"
import respectRepositories from "./respect-repositories.js"

const ROOT = path.resolve(import.meta.dir, "..")
const file = (relative: string) => path.join(ROOT, relative)

RuleTester.describe = describe
RuleTester.it = test
RuleTester.itOnly = test.only

const tester = new RuleTester({
	languageOptions: { ecmaVersion: 2022, sourceType: "module" },
})

tester.run("respect/repositories-only", respectRepositories, {
	valid: [
		{
			code: `import { CORE_DB } from "@db"`,
			filename: file("src/services/users/users.repository.ts"),
		},
		{ code: `import { openSqlite } from "./open-sqlite"`, filename: file("src/db/migrate.ts") },
		{ code: `import { DatabaseModule } from "@db"`, filename: file("src/app.module.ts") },
		{ code: `import { openSqlite } from "@db"`, filename: file("scripts/seed.ts") },
		{ code: `import { x } from "@db"`, filename: file("src/services/users/users.spec.ts") },
		// Legacy matched the substring "db"; these are not the database module.
		{
			code: `import { dbg } from "./dbg-helpers"`,
			filename: file("src/services/users/users.service.ts"),
		},
		{
			code: `import { x } from "@services/feedback/feedback.dto"`,
			filename: file("src/services/users/users.service.ts"),
		},
	],
	invalid: [
		{
			code: `import { CORE_DB } from "@db"`,
			filename: file("src/services/users/users.service.ts"),
			errors: [{ messageId: "noDbImport" }],
		},
		{
			code: `import { openSqlite } from "../../db/open-sqlite"`,
			filename: file("src/services/users/users.controller.ts"),
			errors: [{ messageId: "noDbImport" }],
		},
		{
			code: `export { CORE_DB } from "@db/database.module"`,
			filename: file("src/common/utils/index.ts"),
			errors: [{ messageId: "noDbImport" }],
		},
	],
})

tester.run("respect/no-orm-in-controllers", noOrmInControllers, {
	valid: [
		{
			code: `import { eq } from "drizzle-orm"`,
			filename: file("src/services/users/users.repository.ts"),
		},
		{
			code: `import { UsersRepository } from "./users.repository"`,
			filename: file("src/services/users/users.service.ts"),
		},
	],
	invalid: [
		{
			code: `import { eq } from "drizzle-orm"`,
			filename: file("src/services/users/users.service.ts"),
			errors: [{ messageId: "noOrm" }],
		},
		{
			code: `import { usersTable } from "@schemas"`,
			filename: file("src/services/users/users.controller.ts"),
			errors: [{ messageId: "noOrm" }],
		},
		{
			code: `import { usersTable } from "../../schemas/core/users"`,
			filename: file("src/services/users/users.controller.ts"),
			errors: [{ messageId: "noOrm" }],
		},
	],
})

tester.run("drizzle/imports-only", drizzleImportsOnly, {
	valid: [
		{ code: `import { eq } from "drizzle-orm"` },
		{ code: `import { int } from "drizzle-orm/sqlite-core"` },
		{ code: `import { drizzle } from "drizzle-orm/bun-sqlite"` },
	],
	invalid: [
		{
			code: `import { pgTable } from "drizzle-orm/pg-core"`,
			errors: [{ messageId: "wrongDrizzleImport" }],
		},
		{
			code: `import { drizzle } from "drizzle-orm/better-sqlite3"`,
			errors: [{ messageId: "wrongDrizzleImport" }],
		},
	],
})
