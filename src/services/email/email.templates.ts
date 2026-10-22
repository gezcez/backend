// email.templates.ts
// Templates live in code (reviewed in PRs). Each renders a subject, a text body and a small HTML
// body in the brand colours (cream background, navy text, amber accent, no shadows).

import { t, type LangKey, type Locale } from "@lang"

export interface RenderedEmail {
	subject: string
	text: string
	html: string
}

interface CodeVars {
	code: string
	minutes: number
}

export interface TemplateVars {
	signin_code: CodeVars
	signup_code: CodeVars
	reauth_code: CodeVars
	reset_code: CodeVars
	change_email_code: CodeVars
	reset_unavailable: Record<string, never>
	password_changed: Record<string, never>
	/** Sent to the old address; `email` is the new one, masked. */
	email_changed: { email: string; security_url: string }
	/** `delete_at` is a date in the user's locale. */
	deletion_scheduled: { delete_at: string; cancel_url: string }
	export_ready: { download_url: string; expires_at: string }
}

export type TemplateKey = keyof TemplateVars
export const TEMPLATE_KEYS = [
	"signin_code",
	"signup_code",
	"reauth_code",
	"reset_code",
	"change_email_code",
	"reset_unavailable",
	"password_changed",
	"email_changed",
	"deletion_scheduled",
	"export_ready",
] as const satisfies TemplateKey[]

export interface TemplateVariable {
	name: string
	description: string
	example: string
}

const CODE_VARIABLES: TemplateVariable[] = [
	{ name: "code", description: "One-time code", example: "482913" },
	{ name: "minutes", description: "Minutes until the code expires", example: "10" },
]

/** What the dashboard lists: purpose and variables with sample values for previews. */
export const TEMPLATE_CATALOG: Record<
	TemplateKey,
	{ description: string; variables: TemplateVariable[] }
> = {
	signin_code: { description: "Sign-in code", variables: CODE_VARIABLES },
	signup_code: { description: "Sign-up code", variables: CODE_VARIABLES },
	reauth_code: { description: "Code to confirm a sensitive action", variables: CODE_VARIABLES },
	reset_code: { description: "Password reset code", variables: CODE_VARIABLES },
	change_email_code: {
		description: "Code sent to a new address during an email change",
		variables: CODE_VARIABLES,
	},
	reset_unavailable: {
		description: "Reset asked for an account without a password",
		variables: [],
	},
	password_changed: { description: "Notice after a password change", variables: [] },
	email_changed: {
		description: "Notice to the old address after an email change",
		variables: [
			{ name: "email", description: "New address, masked", example: "e****@example.com" },
			{
				name: "security_url",
				description: "Account security page",
				example: "https://oauth.gezcez.com/account/security",
			},
		],
	},
	deletion_scheduled: {
		description: "Account deletion scheduled (14 day grace)",
		variables: [
			{ name: "delete_at", description: "Deletion date", example: "5 November 2026" },
			{
				name: "cancel_url",
				description: "Page to cancel the deletion",
				example: "https://oauth.gezcez.com/account/privacy",
			},
		],
	},
	export_ready: {
		description: "Data export ready to download",
		variables: [
			{
				name: "download_url",
				description: "Export page",
				example: "https://oauth.gezcez.com/account/privacy",
			},
			{ name: "expires_at", description: "Last download date", example: "29 October 2026" },
		],
	},
}

export function isTemplateKey(value: string): value is TemplateKey {
	return (TEMPLATE_KEYS as readonly string[]).includes(value)
}

/**
 * Template variables from strings (dashboard previews and test sends): sample values fill the
 * gaps and numeric variables are converted.
 */
export function templateVarsFrom<K extends TemplateKey>(
	key: K,
	given: Record<string, string> = {},
): TemplateVars[K] {
	const vars: Record<string, string | number> = {}
	for (const variable of TEMPLATE_CATALOG[key].variables) {
		const value = given[variable.name] ?? variable.example
		vars[variable.name] = variable.name === "minutes" ? Number(value) || 0 : value
	}
	return vars as TemplateVars[K]
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function layout(
	locale: Locale,
	title: string,
	paragraphs: string[],
	code?: string,
): RenderedEmail["html"] {
	const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join("")
	const codeBlock = code
		? `<p style="margin:8px 0 24px;font-size:32px;font-weight:800;letter-spacing:8px;color:#172554;background:#fef3c7;border:2px solid #fbbf24;border-radius:16px;padding:16px 24px;display:inline-block">${escapeHtml(code)}</p>`
		: ""
	return `<!doctype html><html lang="${locale}"><body style="margin:0;background:#fffbeb;font-family:Inter,Arial,sans-serif;color:#172554">
<div style="max-width:480px;margin:0 auto;padding:32px 24px">
<p style="margin:0 0 24px;font-size:20px;font-weight:800;color:#d97706">gezcez</p>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:700">${escapeHtml(title)}</h1>
${body}${codeBlock}
<p style="margin:24px 0 0;font-size:12px;color:#1e3a8a">${escapeHtml(t(locale, "email.footer"))}</p>
</div></body></html>`
}

function codeEmail(
	locale: Locale,
	prefix: "signin_code" | "signup_code" | "reauth_code" | "reset_code" | "change_email_code",
	vars: CodeVars,
): RenderedEmail {
	const key = (suffix: string) => `email.${prefix}.${suffix}` as LangKey
	const title = t(locale, key("title"))
	const intro = t(locale, key("intro"))
	const valid = t(locale, "email.code_valid", { minutes: vars.minutes })
	const ignore = t(locale, "email.ignore")
	return {
		subject: t(locale, key("subject"), { code: vars.code }),
		text: `${title}\n\n${intro}\n\n${vars.code}\n\n${valid}\n${ignore}\n\n${t(locale, "email.footer")}\n`,
		html: layout(locale, title, [intro], vars.code).replace(
			"</div></body>",
			`<p style="margin:0 0 8px">${escapeHtml(valid)}</p><p style="margin:0">${escapeHtml(ignore)}</p></div></body>`,
		),
	}
}

function noticeEmail(
	locale: Locale,
	prefix:
		| "reset_unavailable"
		| "password_changed"
		| "email_changed"
		| "deletion_scheduled"
		| "export_ready",
	vars: Record<string, string> = {},
): RenderedEmail {
	const title = t(locale, `email.${prefix}.title` as LangKey)
	const intro = t(locale, `email.${prefix}.intro` as LangKey, vars)
	return {
		subject: t(locale, `email.${prefix}.subject` as LangKey),
		text: `${title}\n\n${intro}\n\n${t(locale, "email.footer")}\n`,
		html: layout(locale, title, [intro]),
	}
}

export function renderTemplate<K extends TemplateKey>(
	key: K,
	locale: Locale,
	vars: TemplateVars[K],
): RenderedEmail {
	switch (key) {
		case "signin_code":
		case "signup_code":
		case "reauth_code":
		case "reset_code":
		case "change_email_code":
			return codeEmail(locale, key, vars as CodeVars)
		case "reset_unavailable":
		case "password_changed":
			return noticeEmail(locale, key)
		case "email_changed":
		case "deletion_scheduled":
		case "export_ready":
			return noticeEmail(locale, key, vars as Record<string, string>)
		default:
			throw new Error(`Unknown email template ${String(key)}`)
	}
}
