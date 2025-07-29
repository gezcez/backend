export interface IConfig {
	[key: string]: any
	sudo_mode_ttl: number
	third_party_urls: {
		email_service: string
	}
	validation: {
		password: {
			min_length: number
			max_length: number
		}
		username: {
			min_length: number
			max_length: number
		}
		email: {
			min_length: number
			max_length: number
		}
	}
}
