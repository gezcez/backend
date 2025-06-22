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

export {}