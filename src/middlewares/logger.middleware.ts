import { Response, NextFunction } from "express"

export function LoggerMiddleware(
	req: Request,
	res: Response,
	next: NextFunction
) {
	const is_prod = process.env.NODE_ENV !== "dev"
	console.log(`[${req.method}] [${is_prod ? req.headers["CF-Connecting-IP"]: req.ip}] ${req.url}`)
	next()
}
