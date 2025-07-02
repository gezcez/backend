type logType = (string | number)[]
export abstract class logger {
	static success(...strings: logType) {
		console.log(`[${new Date().toISOString()}] backend@gezcez.com: 🟢`, ...strings)
	}
	static warning(...strings: logType) {
		console.log(`[${new Date().toISOString()}] backend@gezcez.com: 🟡`, ...strings)
	}
	static error(...strings: logType) {
		console.log(`[${new Date().toISOString()}] backend@gezcez.com: 🔴`, ...strings)
	}
	static log(...strings: logType) {
		console.log(`[${new Date().toISOString()}] backend@gezcez.com:`, ...strings)
	}
}

export type TJoinStrings<A extends string, B extends string> = `${A}${B}`
import __config from "../service.config.json"
export const config = __config


import { drizzle } from "drizzle-orm/libsql"
export const db = drizzle(process.env.URL_DB || "./GEZCEZ.db")

export {}
