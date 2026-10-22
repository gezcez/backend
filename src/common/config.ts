// config.ts
// Environment loader validated with zod at boot (plan section 9.5). Nothing else reads process.env.

import { Global, Inject, Module, type DynamicModule } from "@nestjs/common"
import path from "node:path"
import { z } from "zod"
import pkg from "../../package.json"

const PRODUCTION_API_URL = "https://api.gezcez.com"

// Development and test fallbacks for secrets. They are refused in production.
const DEV_SECRET = "dev-only-insecure-secret-change-me-0000000000"

const csv = z
	.string()
	.optional()
	.transform((value) =>
		(value ?? "")
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean),
	)

const bool = z
	.enum(["true", "false", "1", "0"])
	.optional()
	.transform((value) => value === "true" || value === "1")

const secret = z.string().min(32, "must be at least 32 characters")

export const EnvSchema = z
	.object({
		NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
		MODE: z.enum(["api", "tracker", "all"]).default("all"),
		HOST: z.string().default("0.0.0.0"),
		PORT: z.coerce.number().int().min(0).max(65535).default(8080),
		DATA_DIR: z.string().default("./data"),
		MIGRATIONS_DIR: z.string().default("./drizzle"),
		PUBLIC_API_URL: z.url().default("http://localhost:8080"),
		ISSUER: z.url().optional(),
		OAUTH_UI_URL: z.url().default("http://localhost:5174"),
		CORS_ORIGINS: csv,
		TRUST_CF_HEADERS: bool,
		LOG_LEVEL: z
			.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
			.default("info"),
		KEY_ENCRYPTION_SECRET: secret.optional(),
		SEAL_SECRET: secret.optional(),
		CODE_PEPPER: secret.optional(),
		CSRF_SECRET: secret.optional(),
		TURNSTILE_SECRET: z.string().optional(),
		STAGING_TEST_OTP: z
			.string()
			.regex(/^\d{6}$/, "must be 6 digits")
			.optional(),
		STEP_UP_MAX_AGE_S: z.coerce.number().int().positive().default(600),
		REFRESH_GRACE_S: z.coerce.number().int().min(0).max(60).default(10),
		/** Multiplies every rate limit (tests raise it; 0 is not allowed). */
		RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
		/** Defaults to memory under NODE_ENV=test (test mailbox), console elsewhere. */
		EMAIL_TRANSPORT: z.enum(["ses", "console", "memory"]).optional(),
		EMAIL_FROM: z.string().default("gezcez <noreply@gezcez.com>"),
		SES_REGION: z.string().optional(),
		SES_ACCESS_KEY_ID: z.string().optional(),
		SES_SECRET_ACCESS_KEY: z.string().optional(),
		SENTRY_DSN: z.string().optional(),
		SENTRY_ENVIRONMENT: z.string().optional(),
		METRICS_TOKEN: z.string().optional(),
		ALERT_WEBHOOK_URL: z.string().optional(),
		GIT_SHA: z.string().default("dev"),
		BUILD_TIME: z.string().optional(),
	})
	.superRefine((env, ctx) => {
		if (env.NODE_ENV === "production" || env.NODE_ENV === "staging") {
			for (const key of [
				"KEY_ENCRYPTION_SECRET",
				"SEAL_SECRET",
				"CODE_PEPPER",
				"CSRF_SECRET",
			] as const) {
				if (!env[key]) {
					ctx.addIssue({
						code: "custom",
						path: [key],
						message: `required when NODE_ENV=${env.NODE_ENV}`,
					})
				}
			}
		}
		if (env.STAGING_TEST_OTP && env.PUBLIC_API_URL.replace(/\/$/, "") === PRODUCTION_API_URL) {
			ctx.addIssue({
				code: "custom",
				path: ["STAGING_TEST_OTP"],
				message: "must not be set on the production API",
			})
		}
		if (env.EMAIL_TRANSPORT === "memory" && env.NODE_ENV !== "test") {
			ctx.addIssue({
				code: "custom",
				path: ["EMAIL_TRANSPORT"],
				message: "memory transport is only allowed when NODE_ENV=test",
			})
		}
	})

export type Env = z.infer<typeof EnvSchema>

export interface AppConfig {
	env: Env["NODE_ENV"]
	isProduction: boolean
	isTest: boolean
	mode: Env["MODE"]
	host: string
	port: number
	dataDir: string
	migrationsDir: string
	publicApiUrl: string
	issuer: string
	oauthUiUrl: string
	corsOrigins: string[]
	trustCfHeaders: boolean
	logLevel: Env["LOG_LEVEL"]
	secrets: {
		keyEncryption: string
		seal: string
		codePepper: string
		csrf: string
		turnstile?: string
	}
	stagingTestOtp?: string
	stepUpMaxAgeS: number
	refreshGraceS: number
	rateLimitScale: number
	email: {
		transport: NonNullable<Env["EMAIL_TRANSPORT"]>
		from: string
		ses: { region?: string; accessKeyId?: string; secretAccessKey?: string }
	}
	sentry: { dsn?: string; environment?: string }
	metricsToken?: string
	alertWebhookUrl?: string
	version: { gitSha: string; buildTime?: string; packageVersion: string }
}

export class ConfigError extends Error {
	constructor(readonly issues: string[]) {
		super(`Invalid environment:\n  ${issues.join("\n  ")}`)
		this.name = "ConfigError"
	}
}

/** Parses and validates an environment object. Throws ConfigError with every problem at once. */
export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
	// Empty variables (FOO=) count as unset, so compose files can list every key.
	const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""))
	const parsed = EnvSchema.safeParse(cleaned)
	if (!parsed.success) {
		throw new ConfigError(
			parsed.error.issues.map(
				(issue) => `${issue.path.join(".") || "env"}: ${issue.message}`,
			),
		)
	}
	const env = parsed.data
	const publicApiUrl = env.PUBLIC_API_URL.replace(/\/$/, "")
	return {
		env: env.NODE_ENV,
		isProduction: env.NODE_ENV === "production",
		isTest: env.NODE_ENV === "test",
		mode: env.MODE,
		host: env.HOST,
		port: env.PORT,
		dataDir: path.resolve(env.DATA_DIR),
		migrationsDir: path.resolve(env.MIGRATIONS_DIR),
		publicApiUrl,
		issuer: (env.ISSUER ?? publicApiUrl).replace(/\/$/, ""),
		oauthUiUrl: env.OAUTH_UI_URL.replace(/\/$/, ""),
		corsOrigins: env.CORS_ORIGINS,
		trustCfHeaders: env.TRUST_CF_HEADERS,
		logLevel: env.LOG_LEVEL,
		secrets: {
			keyEncryption: env.KEY_ENCRYPTION_SECRET ?? DEV_SECRET,
			seal: env.SEAL_SECRET ?? DEV_SECRET,
			codePepper: env.CODE_PEPPER ?? DEV_SECRET,
			csrf: env.CSRF_SECRET ?? DEV_SECRET,
			turnstile: env.TURNSTILE_SECRET,
		},
		stagingTestOtp: env.STAGING_TEST_OTP,
		stepUpMaxAgeS: env.STEP_UP_MAX_AGE_S,
		refreshGraceS: env.REFRESH_GRACE_S,
		rateLimitScale: env.RATE_LIMIT_SCALE,
		email: {
			transport: env.EMAIL_TRANSPORT ?? (env.NODE_ENV === "test" ? "memory" : "console"),
			from: env.EMAIL_FROM,
			ses: {
				region: env.SES_REGION,
				accessKeyId: env.SES_ACCESS_KEY_ID,
				secretAccessKey: env.SES_SECRET_ACCESS_KEY,
			},
		},
		sentry: { dsn: env.SENTRY_DSN, environment: env.SENTRY_ENVIRONMENT },
		metricsToken: env.METRICS_TOKEN,
		alertWebhookUrl: env.ALERT_WEBHOOK_URL,
		version: { gitSha: env.GIT_SHA, buildTime: env.BUILD_TIME, packageVersion: pkg.version },
	}
}

export const APP_CONFIG = Symbol("APP_CONFIG")

/** Parameter decorator: `constructor(@InjectConfig() private readonly config: AppConfig)`. */
export const InjectConfig = () => Inject(APP_CONFIG)

@Global()
@Module({})
export class ConfigModule {
	static forRoot(config: AppConfig): DynamicModule {
		return {
			module: ConfigModule,
			providers: [{ provide: APP_CONFIG, useValue: config }],
			exports: [APP_CONFIG],
		}
	}
}
