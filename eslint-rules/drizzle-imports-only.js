export default {
	meta: {
		type: 'problem',
		docs: {
			description: 'Only allow imports from drizzle-orm/sqlite-core for database operations',
		},
		messages: {
			wrongDrizzleImport: 'Only import from "drizzle-orm/sqlite-core". Other Drizzle packages ({{package}}) are not allowed in this SQLite project.',
		},
		schema: [], // no options
	},
	create(context) {
		return {
			ImportDeclaration(node) {
				const importPath = node.source.value;

				// Check for wrong Drizzle imports
				const wrongDrizzleImports = [
					'drizzle-orm/mysql-core',
					'drizzle-orm/pg-core',
					'drizzle-orm/gel-core',
					'drizzle-orm/planetscale-serverless',
					'drizzle-orm/better-sqlite3',
					// 'drizzle-orm/libsql',
					'drizzle-orm/turso',
					'drizzle-orm/vercel-postgres'
				];

				const isWrongDrizzleImport = wrongDrizzleImports.some(pkg => importPath === pkg);

				if (isWrongDrizzleImport) {
					context.report({
						node,
						messageId: 'wrongDrizzleImport',
						data: {
							package: importPath
						}
					});
				}
			},
		};
	},
};