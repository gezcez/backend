import dark from "../styles/gezcez-dark.json"
import light from "../styles/gezcez-light.json"
import { cacheControl } from "./http"

/** The origin the committed styles are written against (scripts/build-styles.ts). */
const PUBLIC_ORIGIN = "https://tiles.gezcez.com"

const STYLES: Record<string, string> = {
	"gezcez-light": JSON.stringify(light),
	"gezcez-dark": JSON.stringify(dark),
}

/**
 * Serves a style with its tile, glyph and sprite URLs pointed at the host that served it, so a
 * preview or `wrangler dev` host is self-contained.
 */
export function styleResponse(name: string, origin: string, maxAge: number): Response {
	const style = STYLES[name]
	if (style === undefined) throw new Error(`Unknown style ${name}`)
	const body = origin === PUBLIC_ORIGIN ? style : style.replaceAll(PUBLIC_ORIGIN, origin)
	return new Response(body, {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": cacheControl(maxAge),
		},
	})
}
