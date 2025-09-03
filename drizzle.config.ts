import { defineConfig } from 'drizzle-kit';
export default defineConfig({
	out: './drizzle',
	schema: './src/schemas/*.ts',
	dialect: 'sqlite',
	dbCredentials: {
		url: process.env.URL_DB ||"./volume/GEZCEZ.db",
	},
});
