// paginate.ts
// The list contract of plan 7.0 for drizzle queries: whitelisted sort, opaque offset cursor bound
// to the filters, `limit + 1` fetch to detect the next page, and a total counted up to 10 000.

import { asc, desc, type SQL } from "drizzle-orm"
import type { SQLiteColumn } from "drizzle-orm/sqlite-core"
import { cappedTotal, PAGE_TOTAL_CAP, parseSort, type Page, type PageQuery } from "@common/response"
import { decodeCursor, pageFrom } from "@common/utils/pagination.utils"

export interface PaginateOptions<Row, F extends string> {
	query: PageQuery
	/** Every filter that shapes the result; a cursor from other filters is refused. */
	filters: Record<string, unknown>
	sortable: Record<F, SQLiteColumn | SQL>
	defaultSort: string
	/** Unique column appended to every ORDER BY so pages are stable. */
	tieBreaker: SQLiteColumn
	fetch(orderBy: SQL[], limit: number, offset: number): Row[]
	/** Number of matching rows, counting at most `cap` (callers use LIMIT cap). */
	count(cap: number): number
}

export function paginate<Row, F extends string>(options: PaginateOptions<Row, F>): Page<Row> {
	const { query } = options
	const sort = parseSort(query.sort, Object.keys(options.sortable) as F[], options.defaultSort)
	const fingerprint = { ...options.filters, q: query.q ?? null, sort }
	const offset = decodeCursor(query.cursor, fingerprint)
	const orderBy = [
		...sort.map((term) =>
			term.dir === "asc"
				? asc(options.sortable[term.field])
				: desc(options.sortable[term.field]),
		),
		asc(options.tieBreaker),
	]
	const rows = options.fetch(orderBy, query.limit + 1, offset)
	return pageFrom(
		rows,
		offset,
		query.limit,
		fingerprint,
		cappedTotal(options.count(PAGE_TOTAL_CAP + 1)),
	)
}
