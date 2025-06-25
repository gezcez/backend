
declare module "bun" {
	interface Env {
		NODE_ENV?: "dev" | "production"
		PORT?: number
		JWT_SECRET?: string
		INTERNAL_COMM_SECRET?:string
		JWT_RANDOM_STUFF?:string
		URL_DB?: string
		CONFIG_PATH?: string
		HOST?: string
		KEY_EMAIL_SERVICE?: string
	}
}
export { };
