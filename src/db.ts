import { drizzle } from "drizzle-orm/libsql"
export const db = drizzle(process.env.URL_DB || "./GEZCEZ.db")

export {}
