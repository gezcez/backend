export { };

declare module "bun" {
	interface Env {
		NODE_ENV?: "dev"|"production"
		PORT?: number
		JWT_SECRET?: string
		URL_DB?: string
		CONFIG_PATH?: string
		HOST?:(string | "localhost") & {}
	}
}