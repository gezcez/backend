import { defineConfig } from 'drizzle-kit';
export default defineConfig({
	out: './drizzle',
	schema: '../common-utilities/src/schemas/backend/*.ts',
	dialect: 'sqlite',
	dbCredentials: {
		url: process.env.URL_DB ||"./GEZCEZ.db",
	},
});
