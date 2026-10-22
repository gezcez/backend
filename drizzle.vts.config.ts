import { defineConfig } from "drizzle-kit"

export default defineConfig({
	dialect: "sqlite",
	schema: "./src/schemas/vts/index.ts",
	out: "./drizzle/vts",
})
