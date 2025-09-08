import { config } from "../.."
import { emailsTable } from "@schemas"
import { EmailRepository } from "./email.repository"
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2"
import nodemailer from "nodemailer"
const sesClient = new SESv2Client({
	region: process.env.AWS_REGION,
	credentials: {
		accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
	}
})
const transporter = nodemailer.createTransport({
	SES: { sesClient, SendEmailCommand }
})
export abstract class EmailService {
	static async sendEmail(args: Omit<typeof emailsTable.$inferInsert,"uuid">) {
		const access_key = process.env.AWS_ACCESS_KEY_ID
		const secret_key = process.env.AWS_SECRET_ACCESS_KEY
		if (!(access_key && secret_key))
			return {error: "email service credentials are not set in .env"}
		const is_redacted = ["otp", "activation"].includes(args.type)
		const content = args.content
		if (is_redacted) args.content = "[redacted]"

		// TODO: actually send the email
		const insert_result = await EmailRepository.insertEmail({...args,uuid:crypto.randomUUID()})
		if (!insert_result) return {error: "couldn't log email to database"}
		const email_id = insert_result.uuid
		const result = await transporter.sendMail({
			from: "noreply@gezcez.com",
			to: args.target_email,
			subject: args.subject,
			text:
				args.content +
				`\n\nREF:${email_id}---\nThis is an automated message, please do not reply to this email.\nIf you need help or support, visit https://gezcez.com`,
			ses: {
				EmailTags: [{ Name: "type", Value: args.type }]
			}
		})
		const log_result = await EmailRepository.insertSesLog({
			email_uuid: email_id,
			accepted: result?.accepted?.join(","),
			envelope: JSON.stringify(result.envelope),
			messageId: result.messageId ?? "",
			pending: result?.pending?.join(",") ?? "",
			response: result?.response ?? "",
			rejected: result?.rejected?.join(",") ?? ""
		})
		console.log(`email ${email_id} response:`, result.response)
		return {
			email_result: result,
			insert_result: insert_result,
			log_result: log_result,
			email_uuid: email_id
		}

	}
}
