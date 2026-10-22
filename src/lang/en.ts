// en.ts
// English strings for emails and other server-rendered text.

export const en = {
	"email.footer":
		"gezcez, transit for everyone. You got this email because someone used this address on gezcez.",
	"email.ignore": "If this wasn't you, you can ignore this email.",
	"email.code_valid": "The code is valid for {minutes} minutes.",
	"email.signin_code.subject": "Your gezcez sign-in code: {code}",
	"email.signin_code.title": "Sign in to gezcez",
	"email.signin_code.intro": "Use this code to sign in:",
	"email.signup_code.subject": "Your gezcez sign-up code: {code}",
	"email.signup_code.title": "Create your gezcez account",
	"email.signup_code.intro": "Use this code to finish creating your account:",
	"email.reauth_code.subject": "Confirm it's you: {code}",
	"email.reauth_code.title": "Confirm it's you",
	"email.reauth_code.intro": "Use this code to confirm a sensitive action on your account:",
	"email.reset_code.subject": "Your gezcez password reset code: {code}",
	"email.reset_code.title": "Reset your password",
	"email.reset_code.intro": "Use this code to set a new password:",
	"email.reset_unavailable.subject": "Password reset request",
	"email.reset_unavailable.title": "Password reset request",
	"email.reset_unavailable.intro":
		"Someone asked to reset the password for this address, but there is no password to reset. You can always sign in with a code sent to your email.",
	"email.password_changed.subject": "Your gezcez password was changed",
	"email.password_changed.title": "Password changed",
	"email.password_changed.intro":
		"The password of your gezcez account was just changed and every other session was signed out. If this wasn't you, reset your password right away and contact info@gezcez.com.",
	"email.change_email_code.subject": "Confirm your new gezcez email: {code}",
	"email.change_email_code.title": "Confirm your new email address",
	"email.change_email_code.intro":
		"Use this code to make this address the email of your gezcez account:",
	"email.email_changed.subject": "Your gezcez email address was changed",
	"email.email_changed.title": "Email address changed",
	"email.email_changed.intro":
		"The email address of your gezcez account was changed to {email}. If this wasn't you, review your account security at {security_url} and contact info@gezcez.com.",
} as const

export type LangKey = keyof typeof en
