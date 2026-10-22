import js from "@eslint/js"
import tseslint from "typescript-eslint"
import drizzleImportsOnly from "./eslint-rules/drizzle-imports-only.js"
import noOrmInControllers from "./eslint-rules/no-orm-in-controllers.js"
import respectRepositories from "./eslint-rules/respect-repositories.js"

export default tseslint.config(
	{ ignores: ["node_modules", "dist", "drizzle", "coverage", "data", "openapi.json"] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
		plugins: {
			respect: {
				rules: {
					"repositories-only": respectRepositories,
					"no-orm-in-controllers": noOrmInControllers,
				},
			},
			drizzle: { rules: { "imports-only": drizzleImportsOnly } },
		},
		rules: {
			"respect/repositories-only": "error",
			"respect/no-orm-in-controllers": "error",
			"drizzle/imports-only": "error",
			"no-console": "error",
			"@typescript-eslint/consistent-type-imports": [
				"error",
				{
					prefer: "type-imports",
					fixStyle: "inline-type-imports",
					disallowTypeAnnotations: false,
				},
			],
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					destructuredArrayIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
		},
	},
	{
		// Nest needs runtime class references for DI and decorator metadata; type-only imports of
		// injected classes would break emitDecoratorMetadata.
		files: ["src/**/*.ts"],
		rules: { "@typescript-eslint/consistent-type-imports": "off" },
	},
	{
		files: ["scripts/**/*.ts"],
		rules: { "no-console": "off" },
	},
	{
		files: ["eslint-rules/**/*.js", "*.mjs"],
		languageOptions: { globals: { process: "readonly" } },
	},
)
