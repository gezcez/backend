import { defineConfig } from "drizzle-kit"

export default defineConfig({
	dialect: "sqlite",
	schema: "./src/schemas/transit/index.ts",
	out: "./drizzle/transit",
})
