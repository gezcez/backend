export abstract class logger {
	static success(...strings:string[]) {
		console.log(`[${new Date().toISOString()}] backend@gezcez.com: 🟢`,...strings)
	}
	static warning(...strings:string[]) {
		console.log(`[${new Date().toISOString()}] backend@gezcez.com: 🟡`,...strings)
	}
	static error(...strings:string[]) {
		console.log(`[${new Date().toISOString()}] backend@gezcez.com: 🔴`,...strings)
	}
	static log(...strings:string[]) {
		console.log(`[${new Date().toISOString()}] backend@gezcez.com:`,...strings)
	}
} 
import configI from "../service.config.json"
export const config = configI

import { drizzle } from 'drizzle-orm/libsql';
export const db = drizzle(process.env.URL_DB || "./GEZCEZ.db")

export {}