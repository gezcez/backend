// config.ts
// Environment loader validated with zod at boot (plan section 9.5). Nothing else reads process.env.

import { Global, Inject, Module, type DynamicModule } from "@nestjs/common"
import path from "node:path"
import { z } from "zod"
import pkg from "../../package.json"

const PRODUCTION_API_HOST = "api.gezcez.com"

// Development and test fallbacks for secrets. They are refused in staging and production, and
// whenever PUBLIC_API_URL is not a loopback address.
const DEV_SECRET = "dev-only-insecure-secret-change-me-0000000000"

const SECRET_KEYS = ["KEY_ENCRYPTION_SECRET", "SEAL_SECRET", "CODE_PEPPER", "CSRF_SECRET"] as const

/** Lowercased hostname without brackets or a trailing dot; URL handles ports and case. */
export function hostnameOf(url: string): string {
	return new URL(url).hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "")
}

export function isLoopbackHost(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname === "::1" ||
		/^127(\.\d{1,3}){3}$/.test(hostname)
	)
}

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

/** Boolean env flag with a default ("true"/"false"/"1"/"0"). */
function boolFlag(fallback: boolean) {
	return z
		.enum(["true", "false", "1", "0"])
		.optional()
		.transform((value) => (value === undefined ? fallback : value === "true" || value === "1"))
}

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
		/** Path the API is mounted under (e.g. "/api" serves /api/v1/...); stripped before routing. */
		BASE_PATH: z
			.string()
			.regex(/^(\/[\w-]+)*$/)
			.default(""),
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
		/** Defaults to memory under NODE_ENV=test (test mailbox), console elsewhere; ses is
		 * required in staging and production. */
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
		// ---- transit, providers and tracker (P3) ----
		KENTKART_CLIENT_ID: z.string().optional(),
		KENTKART_CLIENT_SECRET: z.string().optional(),
		KENTKART_REFRESH_TOKEN: z.string().optional(),
		/** Env hard kill per provider (plan 8.9); needs a restart. */
		PROVIDER_KENTKART_ENABLED: boolFlag(true),
		PROVIDER_FAKE_ENABLED: boolFlag(true),
		/** Providers whose bindings are served by the fake provider (local runs without credentials). */
		PROVIDER_REPLAY: csv,
		/** worker: Bun Worker (MODE=all); inline: same thread; manual: same thread without timers (tests); off: none. */
		TRACKER_RUNNER: z.enum(["worker", "inline", "manual", "off"]).default("worker"),
		UPSTREAM_MAX_IN_FLIGHT: z.coerce.number().int().min(1).max(32).default(4),
		/** Local quiet hours (HH:MM-HH:MM) with 5 min polling unless vehicles were seen. */
		TRACKER_QUIET_HOURS: z
			.string()
			.regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)
			.or(z.literal("off"))
			.default("01:30-05:00"),
		VTS_HOT_DAYS: z.coerce.number().int().min(1).max(60).default(7),
		/** Retention deletes only days whose archive is verified (off until the archive ships). */
		VTS_RETENTION_REQUIRE_ARCHIVE: boolFlag(true),
		/** Daily static sync time (local, Europe/Istanbul); "off" disables the schedule. */
		TRANSIT_SYNC_AT: z
			.string()
			.regex(/^\d{2}:\d{2}$/)
			.or(z.literal("off"))
			.default("04:00"),
		// ---- archive and analytics (P3, plan 5.4, 6.8, 6.9, 8.8) ----
		/** Daily Parquet export of the previous UTC date (local Europe/Istanbul time) or "off". */
		ARCHIVE_EXPORT_AT: z
			.string()
			.regex(/^\d{2}:\d{2}$/)
			.or(z.literal("off"))
			.default("03:30"),
		/** Nightly materialised aggregates under data/agg (local time) or "off". */
		AGGREGATES_AT: z
			.string()
			.regex(/^\d{2}:\d{2}$/)
			.or(z.literal("off"))
			.default("04:30"),
		/** Days of Parquet partitions kept on local disk (uploaded ones only). */
		ARCHIVE_LOCAL_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
		/** none: keep files local; local: copy to ARCHIVE_MIRROR_DIR; s3: R2 (S3 API). */
		ARCHIVE_UPLOAD: z.enum(["none", "local", "s3"]).default("none"),
		ARCHIVE_MIRROR_DIR: z.string().optional(),
		R2_ENDPOINT: z.url().optional(),
		R2_BUCKET: z.string().optional(),
		R2_ACCESS_KEY_ID: z.string().optional(),
		R2_SECRET_ACCESS_KEY: z.string().optional(),
		R2_PREFIX: z.string().default(""),
		DUCKDB_THREADS: z.coerce.number().int().min(1).max(64).default(2),
		DUCKDB_MEMORY_LIMIT: z.string().default("1GB"),
		/** Where the image preinstalls DuckDB extensions (h3); unset uses DuckDB's default. */
		DUCKDB_EXTENSION_DIR: z.string().optional(),
		ANALYTICS_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(10_000),
		ANALYTICS_MAX_CONCURRENT: z.coerce.number().int().min(1).max(16).default(2),
	})
	.superRefine((env, ctx) => {
		if (env.ARCHIVE_UPLOAD === "s3") {
			for (const key of [
				"R2_ENDPOINT",
				"R2_BUCKET",
				"R2_ACCESS_KEY_ID",
				"R2_SECRET_ACCESS_KEY",
			] as const) {
				if (!env[key])
					ctx.addIssue({
						code: "custom",
						path: [key],
						message: "required when ARCHIVE_UPLOAD=s3",
					})
			}
		}
		if (env.ARCHIVE_UPLOAD === "local" && !env.ARCHIVE_MIRROR_DIR) {
			ctx.addIssue({
				code: "custom",
				path: ["ARCHIVE_MIRROR_DIR"],
				message: "required when ARCHIVE_UPLOAD=local",
			})
		}
		const issue = (path: string, message: string) =>
			ctx.addIssue({ code: "custom", path: [path], message })
		const deployed = env.NODE_ENV === "production" || env.NODE_ENV === "staging"
		const host = hostnameOf(env.PUBLIC_API_URL)
		// Fail closed: the dev fallbacks are public, so anything reachable needs real secrets.
		if (deployed || (env.NODE_ENV === "development" && !isLoopbackHost(host))) {
			const why = deployed ? `NODE_ENV=${env.NODE_ENV}` : "PUBLIC_API_URL is not loopback"
			for (const key of SECRET_KEYS) if (!env[key]) issue(key, `required when ${why}`)
		}
		if (deployed) {
			if (!env.TURNSTILE_SECRET)
				issue("TURNSTILE_SECRET", `required when NODE_ENV=${env.NODE_ENV}`)
			if (env.EMAIL_TRANSPORT !== "ses")
				issue("EMAIL_TRANSPORT", `must be ses when NODE_ENV=${env.NODE_ENV}`)
			else if (!env.SES_REGION) issue("SES_REGION", `required when NODE_ENV=${env.NODE_ENV}`)
		}
		if (
			env.STAGING_TEST_OTP &&
			(env.NODE_ENV === "production" || host === PRODUCTION_API_HOST)
		) {
			issue("STAGING_TEST_OTP", "must not be set on the production API")
		}
		if (env.EMAIL_TRANSPORT === "memory" && env.NODE_ENV !== "test") {
			issue("EMAIL_TRANSPORT", "memory transport is only allowed when NODE_ENV=test")
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
	basePath: string
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
	transit: TransitConfig
	analytics: AnalyticsConfig
}

export interface AnalyticsConfig {
	/** data/archive: Parquet partitions region=<binding>/date=YYYY-MM-DD. */
	archiveDir: string
	/** data/agg: materialised aggregates. */
	aggDir: string
	/** Seconds after local midnight, or null when the schedule is off. */
	exportAt: number | null
	aggregatesAt: number | null
	localDays: number
	upload:
		| { kind: "none" }
		| { kind: "local"; dir: string }
		| {
				kind: "s3"
				endpoint: string
				bucket: string
				accessKeyId: string
				secretAccessKey: string
				prefix: string
		  }
	duckdb: { threads: number; memoryLimit: string; extensionDir?: string }
	timeoutMs: number
	maxConcurrent: number
}

export interface TransitConfig {
	kentkart: { clientId?: string; clientSecret?: string; refreshToken?: string }
	/** Env level of the provider kill switch, by provider key. */
	providerEnabled: Record<string, boolean>
	providerReplay: string[]
	trackerRunner: "worker" | "inline" | "manual" | "off"
	upstreamMaxInFlight: number
	quietHours: { start: number; end: number } | null
	hotDays: number
	retentionRequireArchive: boolean
	/** Seconds after local midnight, or null when the schedule is off. */
	syncAt: number | null
}

function clockSeconds(value: string): number {
	const [h, m] = value.split(":").map(Number)
	return (h ?? 0) * 3600 + (m ?? 0) * 60
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
		basePath: env.BASE_PATH,
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
		transit: {
			kentkart: {
				clientId: env.KENTKART_CLIENT_ID,
				clientSecret: env.KENTKART_CLIENT_SECRET,
				refreshToken: env.KENTKART_REFRESH_TOKEN,
			},
			providerEnabled: {
				kentkart: env.PROVIDER_KENTKART_ENABLED,
				fake: env.PROVIDER_FAKE_ENABLED,
			},
			providerReplay: env.PROVIDER_REPLAY,
			trackerRunner: env.TRACKER_RUNNER,
			upstreamMaxInFlight: env.UPSTREAM_MAX_IN_FLIGHT,
			quietHours:
				env.TRACKER_QUIET_HOURS === "off"
					? null
					: {
							start: clockSeconds(env.TRACKER_QUIET_HOURS.split("-")[0]!),
							end: clockSeconds(env.TRACKER_QUIET_HOURS.split("-")[1]!),
						},
			hotDays: env.VTS_HOT_DAYS,
			retentionRequireArchive: env.VTS_RETENTION_REQUIRE_ARCHIVE,
			syncAt: env.TRANSIT_SYNC_AT === "off" ? null : clockSeconds(env.TRANSIT_SYNC_AT),
		},
		analytics: {
			archiveDir: path.join(path.resolve(env.DATA_DIR), "archive"),
			aggDir: path.join(path.resolve(env.DATA_DIR), "agg"),
			exportAt: env.ARCHIVE_EXPORT_AT === "off" ? null : clockSeconds(env.ARCHIVE_EXPORT_AT),
			aggregatesAt: env.AGGREGATES_AT === "off" ? null : clockSeconds(env.AGGREGATES_AT),
			localDays: env.ARCHIVE_LOCAL_DAYS,
			upload:
				env.ARCHIVE_UPLOAD === "s3"
					? {
							kind: "s3",
							endpoint: env.R2_ENDPOINT!,
							bucket: env.R2_BUCKET!,
							accessKeyId: env.R2_ACCESS_KEY_ID!,
							secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
							prefix: env.R2_PREFIX,
						}
					: env.ARCHIVE_UPLOAD === "local"
						? { kind: "local", dir: path.resolve(env.ARCHIVE_MIRROR_DIR!) }
						: { kind: "none" },
			duckdb: {
				threads: env.DUCKDB_THREADS,
				memoryLimit: env.DUCKDB_MEMORY_LIMIT,
				extensionDir: env.DUCKDB_EXTENSION_DIR,
			},
			timeoutMs: env.ANALYTICS_TIMEOUT_MS,
			maxConcurrent: env.ANALYTICS_MAX_CONCURRENT,
		},
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
