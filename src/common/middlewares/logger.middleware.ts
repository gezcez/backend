import type { Response, Request, NextFunction } from "express"
import { logger } from "@common/utils"

export function LoggerMiddleware(
	req: Request,
	res: Response,
	next: NextFunction
) {
	const res_status = res.statusCode
	const is_prod = process.env.NODE_ENV !== "dev"
	logger.log(`${res_status} - [${req.method}] [${is_prod ? req.headers["CF-Connecting-IP"]: req.ip}] ${req.url}`)
	next()
}
