import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import parser from "@typescript-eslint/parser"
import respectRepositories from './eslint-rules/respect-repositories.js';
import drizzleImportsOnly from './eslint-rules/drizzle-imports-only.js';

/** @type {import("eslint").FlatConfig.ConfigArray} */
export default [
	// js.configs.recommended, // Base JS rules
	// tseslint.configs.recommended, // Base TS rules from @typescript-eslint

	{

		
		files: ['**/*.ts'],
		languageOptions: {
			parser: parser,
			parserOptions: {
				project: './tsconfig.json',
				sourceType: 'module',
			},
		},
		plugins: {
			respect: {
				rules: {
					'repositories-only': respectRepositories,
				},
			},
			drizzle: {
				rules: {
					'imports-only': drizzleImportsOnly,
				},
			},
		},
		rules: {
			'respect/repositories-only': 'error',
			'drizzle/imports-only': 'error',
		},
	},
];