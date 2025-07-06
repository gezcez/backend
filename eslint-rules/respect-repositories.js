export default {
	meta: {
		type: 'problem',
		docs: {
			description: 'Dont allow importing db module outside of repository files',
		},
		messages: {
			noDbImport: 'Importing stuff related to db is only allowed in *repository.ts files.',
		},
		schema: [], // no options
	},
	create(context) {

		const filename = context.getFilename();

		const isRepositoryFile = /repository\.ts$/.test(filename) || filename === "authorization.utils.ts" ;

		return {
			ImportDeclaration(node) {
				
				const importPath = node.source.value;
				// Adjust this to match your db module's path
				const isDbImport = importPath.includes("schemas") || importPath.includes("db");

				if (isDbImport && !isRepositoryFile) {
					context.report({
						node,
						messageId: 'noDbImport',
					});
				}
			},
		};
	},
};

// thanks chatgpt for the eslint rules