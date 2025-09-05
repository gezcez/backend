import { config } from "../.."
import { emailsTable } from "@schemas" 
import { EmailRepository } from "./email.repository"

export abstract class EmailService {
	static async sendEmail(args: typeof emailsTable.$inferInsert, uuid: string) {
		const api_key = process.env.KEY_EMAIL_SERVICE
		if (!api_key) return [undefined, "process.env.KEY_EMAIL_SERVICE is undefined"]
		const is_redacted = ["otp", "activation"].includes(args.type)
		const content = args.content
		if (is_redacted) args.content = "[redacted]"
		const url = config.third_party_urls.email_service
		if (!url) return [undefined, "config.third_party_urls.email_service is undefined"]

		// send email
		let request
		try {
			request = await fetch(url, {
				method: "POST",
				headers: { Authorization: api_key },
				body: JSON.stringify({
					yooo: "helloo world",
				}),
			})
		} catch {}
		if ((!request || ![201, 200].includes(request.status)) && process.env.NODE_ENV !== "dev")
			return [undefined, "couldn't send email [third party service threw an error]"]
		const result = await EmailRepository.insertEmails(args)
		return [result,undefined]
	}
}
