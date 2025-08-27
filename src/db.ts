import { drizzle } from "drizzle-orm/libsql"
export const db = drizzle(process.env.URL_DB || "file:GEZCEZ.db")

export {}
