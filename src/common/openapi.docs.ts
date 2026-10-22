// openapi.docs.ts
// Prose published with openapi.json: the API introduction (getting started, envelope, errors,
// pagination, ids, caching, rate limits), the tag descriptions with the auth flows guide, and the
// x-tagGroups Scalar uses for its sidebar. Documentation only; nothing here changes behaviour.

import { ERROR_CODES, type ErrorCode } from "./errors"
import { RATE_LIMIT_PRESETS } from "./rate-limits"
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, PAGE_TOTAL_CAP } from "./response"

const REPO_DOCS = "https://github.com/gezcez/backend/blob/main/docs"

function rateLimitTable(): string {
	const rows = Object.entries(RATE_LIMIT_PRESETS).map(([preset, rules]) => {
		const text = rules
			.map((rule) => {
				const minutes = rule.windowMs / 60_000
				const window = minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`
				return `${rule.limit} per ${rule.by} per ${window}`
			})
			.join(", ")
		return `| \`${preset}\` | ${text} |`
	})
	return ["| Preset | Limit |", "| --- | --- |", ...rows].join("\n")
}

function errorCodeTable(): string {
	const rows = (Object.entries(ERROR_CODES) as [ErrorCode, { status: number; message: string }][])
		.map(([code, { status, message }]) => `| \`${code}\` | ${status} | ${message} |`)
	return ["| Code | HTTP | Meaning |", "| --- | --- | --- |", ...rows].join("\n")
}

export function apiDescription(): string {
	return `The gezcez API serves public transit data (cities, networks, routes, stops, timetables, live
vehicles and departures), the rider app's account features, the OAuth 2.1 authorization server
behind \`oauth.gezcez.com\`, and the staff dashboard.

Base URL \`https://api.gezcez.com\` (staging \`https://api-staging.gezcez.com\`). Everything except
the probes and \`/.well-known/*\` lives under \`/v1\`. This document is the contract every client
generates its types from; it is served at \`/openapi.json\` and attached to every release. A
longer walkthrough for third-party developers lives in [docs/getting-started.md](${REPO_DOCS}/getting-started.md).

## Getting started

Transit reads are public: no key, no token, no sign-up. Start from the city list and follow ids:

\`\`\`sh
curl https://api.gezcez.com/v1/cities
curl https://api.gezcez.com/v1/cities/kocaeli/manifest
curl "https://api.gezcez.com/v1/networks/kocaeli-ulasimpark/routes?q=umuttepe"
curl https://api.gezcez.com/v1/stops/1.41003/departures
\`\`\`

The manifest lists each network's \`capabilities\` (which endpoints have data there) and
\`pack_version\`. Clients that work offline download \`GET /v1/networks/{networkId}/pack\` once and
again only when \`pack_version\` changes. Live vehicles and departures stream over the WebSocket at
\`wss://api.gezcez.com/v1/ws\` ([protocol](${REPO_DOCS}/realtime.md)); the REST endpoints under
**Live data** are the cold-start and polling fallback.

Endpoints for a signed-in user (\`/v1/me\`, favourites) need an OAuth access token; see
**Authentication** for the flows.

## Response envelope

Every JSON response is wrapped, except \`/v1/oauth/token\`, \`/v1/oauth/revoke\`,
\`/.well-known/*\`, \`/health\` and \`/ready\`, which keep their standard shapes:

\`\`\`json
{ "ok": true, "data": { "id": "1.41003", "name": "Kocaeli Kongre Merkezi" } }
\`\`\`

\`\`\`json
{
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Stop not found",
    "request_id": "01JBQ7Z4X8K2M5N9P3R6T1V0WY"
  }
}
\`\`\`

JSON field names are snake_case. Times are ISO 8601 strings in REST bodies and unix seconds in
tokens and WebSocket frames. \`request_id\` equals the \`x-request-id\` response header; quote it
when reporting a problem.

## Errors

Branch on \`error.code\`, never on \`message\` (English developer text that may change). The HTTP
status always matches the code. Every operation lists the codes it can return; anything else is
\`INTERNAL\` (500). \`VALIDATION_FAILED\` carries \`details.fields\`, a list of
\`{ path, message, code }\`; \`RATE_LIMITED\` carries \`details.retry_after\` in seconds;
\`SCOPE_MISSING\` carries \`details.required\`.

${errorCodeTable()}

## Pagination

List endpoints share one contract. Query: \`limit\` (1 to ${PAGE_LIMIT_MAX}, default
${PAGE_LIMIT_DEFAULT}), \`cursor\` (opaque, from the previous page), \`sort\` (comma list of
\`field:asc|desc\`, only the fields an endpoint names) and \`q\` (free text), plus flat filters.
Response \`data\`:

\`\`\`json
{ "items": [], "next_cursor": "eyJvIjo1MCwiZiI6IjNmYTFjMmQ0ZTVmNiJ9", "prev_cursor": null, "total": 412 }
\`\`\`

- Follow \`next_cursor\` until it is \`null\`. Do not build or edit cursors.
- A cursor is bound to the filters, \`q\` and \`sort\` it was issued for; changing any of them
  and reusing it is \`VALIDATION_FAILED\` (\`details.fields\` names \`cursor\`). Start over without
  a cursor.
- \`total\` is exact up to ${PAGE_TOTAL_CAP.toLocaleString("en-US")} and \`null\` above that.
- An unknown \`sort\` field is \`VALIDATION_FAILED\` listing the allowed fields.
- \`GET /v1/networks/{networkId}/routes\` returns every route when \`limit\` is omitted (it is small
  enough to cache whole) and pages only when you pass \`limit\`.

## Ids

Cities and networks accept the slug or the numeric id (\`kocaeli\`, \`kocaeli-ulasimpark\`).
Routes, stops and vehicles use stable public ids \`<binding>.<provider id>\` such as \`1.42041\`;
they survive data re-syncs, so you can store them in bookmarks and deep links. Numeric row ids
never leave the API.

## Caching

Public reads send \`Cache-Control\` (for example 10 minutes for routes and stops, 7 days for
shapes, 5 to 15 seconds for live data) and are cached at the edge. The city manifest, network
manifest and offline pack send a strong \`ETag\` and answer \`304 Not Modified\` to a matching
\`If-None-Match\`.

## Rate limits

Limits are per client IP unless noted. Every route not listed falls under \`public-read\`.
Exceeding one answers 429 \`RATE_LIMITED\` with \`details.retry_after\`.

${rateLimitTable()}

The WebSocket has its own limits, sent in the \`hello\` message.

## Versioning

The \`/v1\` contract only grows: new fields, endpoints and error codes can appear at any time, so
ignore unknown fields and treat unknown error codes like \`INTERNAL\`. Breaking changes go to a new
prefix.`
}

const AUTH_GUIDE = `OAuth 2.1 authorization server and the endpoints the sign-in UI at \`oauth.gezcez.com\`
uses. Discovery: \`GET /.well-known/openid-configuration\`; signing keys: \`GET /.well-known/jwks.json\`.

## Which flow

| Client | Flow | Refresh token |
| --- | --- | --- |
| Mobile and desktop apps (public clients) | Authorization code + PKCE, system browser | In the response body; store it in the OS keychain |
| Server-side web apps (confidential clients) | Authorization code + PKCE + client secret | In the response body; keep it server side |
| First-party web apps with \`refresh_cookie\` (the dashboard) | Authorization code + PKCE | \`gz_rt\` cookie (HttpOnly, SameSite=Strict, \`Path=/v1/oauth\`), never in the body |

Transit reads need no token at all. Register a client in the dashboard (Apps) to get a
\`client_id\` and exact redirect URIs.

## Authorization code with PKCE

1. Create a \`code_verifier\` (43 to 128 random URL-safe characters) and its
   \`code_challenge = BASE64URL(SHA256(code_verifier))\`. PKCE \`S256\` is required for every
   client, confidential ones included.
2. Open \`https://oauth.gezcez.com/authorize\` with \`response_type=code\`, \`client_id\`,
   \`redirect_uri\` (byte-for-byte equal to a registered one), \`scope\`, \`state\`,
   \`code_challenge\` and \`code_challenge_method=S256\`. Optional: \`prompt\`
   (\`none\`, \`login\`, \`consent\`, \`select_account\`), \`max_age\`, \`login_hint\`,
   \`ui_locales\` (\`tr\` or \`en\`).
3. The user signs in (email code or password) and, for third-party apps, approves the scopes.
   The browser comes back to \`redirect_uri?code=...&state=...\`, or with
   \`error=access_denied|login_required|consent_required|invalid_scope|...\`. Check \`state\`.
4. Exchange the code within 60 seconds (single use):

\`\`\`http
POST /v1/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=...&redirect_uri=gezcez%3A%2F%2Foauth%2Fcallback&client_id=mobile&code_verifier=...
\`\`\`

\`\`\`json
{ "access_token": "eyJhbGciOiJFUzI1NiIsImtpZCI6IjIwMjYtMTAifQ...", "token_type": "Bearer",
  "expires_in": 900, "refresh_token": "kX3v9QeR2mYt...", "scope": "openid profile transit offline_access" }
\`\`\`

Confidential clients authenticate with HTTP Basic (\`client_secret_basic\`) or \`client_secret\` in
the body. Request \`offline_access\` to get a refresh token.

## Calling the API

Send \`Authorization: Bearer <access_token>\`. Access tokens are ES256 JWTs (about 15 minutes,
\`expires_in\` says exactly) with \`iss\`, \`sub\` (user id), \`aud\` (client id), \`scope\`,
\`sid\`, \`auth_time\` and \`amr\`. They carry no permissions: call \`GET /v1/me\`. Errors:
\`AUTH_REQUIRED\` (no header), \`AUTH_TOKEN_INVALID\`, \`AUTH_TOKEN_EXPIRED\` (refresh and retry
once), \`AUTH_SESSION_REVOKED\` (the user signed out or was banned: sign in again) and
\`SCOPE_MISSING\` (\`details.required\` lists the scopes).

## Refreshing

\`grant_type=refresh_token&refresh_token=...&client_id=...\`. Every refresh rotates the token:
store the new one and discard the old one. Presenting a rotated token again more than 10 seconds
later is treated as theft: the whole token family and the session are revoked and you get
\`invalid_grant\`. Within those 10 seconds the same successor is returned, so a retried request is
safe, but serialise refreshes in your client (one in flight at a time). Cookie clients post an
empty body with \`credentials: "include"\`.

## Signing out

\`POST /v1/oauth/revoke\` with \`token=<refresh token>\` (RFC 7009) ends that token family; it
always answers 200, even for an unknown token. Web apps that want to end the browser's SSO
session send the user to \`https://oauth.gezcez.com/logout\`.

## Scopes

| Scope | Grants |
| --- | --- |
| \`openid\` | Identify the user (\`sub\`) |
| \`profile\` | Read and change display name and locale (\`PATCH /v1/me\`) |
| \`email\` | The user's email address |
| \`offline_access\` | A refresh token |
| \`transit\` | The rider's synced data: favourites |
| \`cards\` | Transit card features (reserved) |
| \`dash\` | The staff dashboard API (first-party only) |

\`GET /v1/oauth/scopes\` lists them with i18n keys.

## Errors on the protocol endpoints

\`/v1/oauth/token\` and \`/v1/oauth/revoke\` answer RFC 6749 errors without the envelope:
\`{ "error": "invalid_grant", "error_description": "..." }\` with \`invalid_request\`,
\`invalid_client\` (401), \`invalid_grant\`, \`unauthorized_client\`, \`unsupported_grant_type\`,
\`invalid_scope\` or \`slow_down\`.

## The sign-in UI's endpoints

\`/v1/oauth/authorize*\`, \`/v1/oauth/logout\` and \`/v1/account/*\` serve the first-party sign-in
UI. They use the \`__Host-gz_session\` and \`__Host-gz_device\` cookies, accept requests only from
the UI's origin and need \`X-CSRF-Token\` (from \`GET /v1/account/csrf\`) on writes. Third-party
clients never call them.`

const REALTIME_SUMMARY = `Live vehicle positions and departures. The primary channel is the WebSocket at
\`wss://api.gezcez.com/v1/ws\` (URL also in \`/v1/app/config\` as \`ws_url\`): connect, wait for
\`hello\`, send \`{"type":"subscribe","id":"map","channel":"vehicles","params":{"network":"kocaeli-ulasimpark"}}\`
and apply the \`snapshot\` then each \`delta\`. Message schemas are published as \`WsClientMessage\`
and \`WsServerMessage\`; the full protocol (channels, sequence numbers, heartbeat, reconnect,
limits and close codes) is in [docs/realtime.md](${REPO_DOCS}/realtime.md).

The REST endpoints here return the same data for a cold start or when the socket is unavailable
(poll vehicles every 15 s and departures every 20 s at most).`

export interface TagDoc {
	name: string
	"x-displayName": string
	description: string
}

export const TAG_DOCS: TagDoc[] = [
	{
		name: "transit",
		"x-displayName": "Transit data",
		description:
			"Cities, networks, routes, stops, timetables, shapes, search and the offline pack. Public, " +
			"no token, cached at the edge. Start at `GET /v1/cities` and follow the slugs and ids.",
	},
	{ name: "transit: live", "x-displayName": "Live data", description: REALTIME_SUMMARY },
	{
		name: "transit: cards",
		"x-displayName": "Transit cards",
		description:
			"Card balance and history by card number where the network's `capabilities.card` allows " +
			"it. POST so the number stays out of URLs and logs; the number is passed to the provider " +
			"and never stored. Rate limited to 60 requests per IP per hour.",
	},
	{
		name: "public: analytics",
		"x-displayName": "Open data",
		description:
			"Aggregate statistics anyone may use: daily data reliability per city and the fleet in " +
			"service. No vehicle or trip identifiers. Rate limited to 30 requests per IP per minute.",
	},
	{
		name: "me",
		"x-displayName": "Signed-in user",
		description:
			"The user behind an access token and their synced data. Needs `Authorization: Bearer`; " +
			"see **Authentication**.",
	},
	{
		name: "app",
		"x-displayName": "App config",
		description:
			"Remote configuration for the rider app: update policy, flags, kill switches, " +
			"announcement, map styles and the WebSocket URL.",
	},
	{
		name: "telemetry",
		"x-displayName": "Telemetry",
		description:
			"Anonymous daily usage counters from the rider app. No user, device, install or session " +
			"identifier is accepted or derived.",
	},
	{ name: "oauth", "x-displayName": "Authentication", description: AUTH_GUIDE },
	{
		name: "account",
		"x-displayName": "Account (sign-in UI)",
		description:
			"Sign-in, sign-up and self-service for the first-party UI at `oauth.gezcez.com`. Cookie " +
			"authenticated (`__Host-gz_session`), CSRF protected, same-site only; not for " +
			"third-party clients.",
	},
	{
		name: "system",
		"x-displayName": "System",
		description:
			"Probes and build information. `/health` and `/ready` sit outside `/v1` and the " +
			"envelope; `/ready` answers 503 while a dependency is down.",
	},
	{
		name: "dash",
		"x-displayName": "Dashboard",
		description:
			"Staff dashboard API: users, roles, apps, audit, moderation and email. Needs a token " +
			"with the `dash` scope and the permission named on each operation.",
	},
	{
		name: "dash: catalog",
		"x-displayName": "Dashboard: catalog",
		description: "Cities, networks, providers, bindings and static data syncs (staff).",
	},
	{
		name: "dash: tracker",
		"x-displayName": "Dashboard: tracker",
		description: "Live vehicle tracker state, polls and controls per binding (staff).",
	},
	{
		name: "dash: analytics",
		"x-displayName": "Dashboard: analytics",
		description: "Network metrics from the archive and aggregates (staff).",
	},
	{
		name: "dash: archive",
		"x-displayName": "Dashboard: archive",
		description: "Parquet archive status and exports (staff).",
	},
]

export const TAG_GROUPS: { name: string; tags: string[] }[] = [
	{
		name: "Public transit API",
		tags: ["transit", "transit: live", "transit: cards", "public: analytics"],
	},
	{ name: "Authentication", tags: ["oauth"] },
	{ name: "Rider app", tags: ["me", "app", "telemetry"] },
	{ name: "Sign-in UI", tags: ["account"] },
	{
		name: "Dashboard",
		tags: ["dash", "dash: catalog", "dash: tracker", "dash: analytics", "dash: archive"],
	},
	{ name: "Operations", tags: ["system"] },
]

/**
 * Tag objects for every tag the document uses (documented ones first, in TAG_DOCS order) and
 * the tag groups, with any tag not named in TAG_GROUPS added to an "Other" group so Scalar
 * never hides an operation.
 */
export function tagsFor(used: Iterable<string>): {
	tags: TagDoc[]
	groups: { name: string; tags: string[] }[]
} {
	const usedSet = new Set(used)
	const tags = TAG_DOCS.filter((tag) => usedSet.has(tag.name))
	for (const name of [...usedSet].sort())
		if (!TAG_DOCS.some((tag) => tag.name === name))
			tags.push({ name, "x-displayName": name, description: "" })
	const grouped = new Set(TAG_GROUPS.flatMap((group) => group.tags))
	const groups = TAG_GROUPS.map((group) => ({
		name: group.name,
		tags: group.tags.filter((tag) => usedSet.has(tag)),
	})).filter((group) => group.tags.length)
	const other = [...usedSet].filter((tag) => !grouped.has(tag)).sort()
	if (other.length) groups.push({ name: "Other", tags: other })
	return { tags, groups }
}

/** `x-enumDescriptions` for the ErrorCode schema: HTTP status and meaning per code. */
export function errorCodeDescriptions(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(ERROR_CODES).map(([code, { status, message }]) => [
			code,
			`${status}: ${message}`,
		]),
	)
}
