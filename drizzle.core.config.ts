import { defineConfig } from "drizzle-kit"

export default defineConfig({
	dialect: "sqlite",
	schema: "./src/schemas/core/index.ts",
	out: "./drizzle/core",
})
