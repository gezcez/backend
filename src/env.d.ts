declare module "bun" {
	interface Env {
		NODE_ENV?: "dev" | "production"

		// http server config
		PORT?: number
		HOST?: string

		// main jwt secret to handle authentication
		JWT_SECRET?: string
		// jwt secret to handle relatively non important stuff like email activation tokens etc.
		JWT_RANDOM_STUFF?: string

		// sqlite db url (local file)
		URL_DB?: string

		// api-key for email provider (you should probably see email.service.ts for more info)
		KEY_EMAIL_SERVICE?: string

		// secret key to handle encrypted communication between internal service and public service
		INTERNAL_COMM_SECRET?: string
		// set this to true if you weren't informed about any internal services and just wanna host
		// your own gezcez.com instance.
		ESCAPE_INTERNAL_SERVICE?: boolean
	}
}
export {}
