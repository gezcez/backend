import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import parser from "@typescript-eslint/parser"
import respectRepositories from './eslint-rules/respect-repositories.js';

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
		},
		rules: {
			'respect/repositories-only': 'error',
		},
	},
];