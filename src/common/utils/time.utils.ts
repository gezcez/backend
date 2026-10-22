// time.utils.ts
// Region time zones and service-day helpers. Timetables are in seconds after local midnight.

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
	let f = formatters.get(timeZone)
	if (!f) {
		f = new Intl.DateTimeFormat("en-GB", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			weekday: "short",
		})
		formatters.set(timeZone, f)
	}
	return f
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

export interface LocalTime {
	/** YYYY-MM-DD in the zone. */
	date: string
	/** 0 = Monday ... 6 = Sunday. */
	weekday: number
	/** Seconds after local midnight. */
	secondsOfDay: number
}

/** Local calendar parts of a unix-seconds instant in `timeZone`. */
export function localTime(unixSeconds: number, timeZone: string): LocalTime {
	const parts: Record<string, string> = {}
	for (const part of formatter(timeZone).formatToParts(new Date(unixSeconds * 1000)))
		parts[part.type] = part.value
	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		weekday: WEEKDAYS.indexOf(parts.weekday ?? "Mon"),
		secondsOfDay: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second),
	}
}

/** Bit for a weekday in a GTFS-style days mask (Mon = 1 ... Sun = 64). */
export function weekdayBit(weekday: number): number {
	return 1 << weekday
}

/** Unix seconds of local midnight of the service day containing `unixSeconds`. */
export function serviceDayStart(unixSeconds: number, timeZone: string): number {
	return unixSeconds - localTime(unixSeconds, timeZone).secondsOfDay
}

/** Weekday (0 = Monday) of a YYYY-MM-DD date. */
export function weekdayOfDate(date: string): number {
	const d = new Date(`${date}T12:00:00Z`)
	return (d.getUTCDay() + 6) % 7
}

/** Adds days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
	const d = new Date(`${date}T12:00:00Z`)
	d.setUTCDate(d.getUTCDate() + days)
	return d.toISOString().slice(0, 10)
}

/** Unix seconds of `secondsAfterMidnight` on local date `date` in `timeZone`. */
export function zonedInstant(date: string, secondsAfterMidnight: number, timeZone: string): number {
	// Start from UTC midnight and correct by the zone offset at that instant (no DST in TR, but
	// stay correct for zones that have it by re-checking once).
	const utcMidnight = Date.parse(`${date}T00:00:00Z`) / 1000
	let guess = utcMidnight
	for (let i = 0; i < 2; i++) {
		const local = localTime(guess, timeZone)
		const dayShift = (Date.parse(`${local.date}T00:00:00Z`) / 1000 - utcMidnight) / 86400
		guess -= dayShift * 86400 + local.secondsOfDay
	}
	return guess + secondsAfterMidnight
}

/** "07:05" style label for seconds after midnight (wraps past 24 h as "24:10"). */
export function clockLabel(seconds: number): string {
	const h = Math.floor(seconds / 3600)
	const m = Math.floor((seconds % 3600) / 60)
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}
