// kentkart.types.ts
// Raw upstream shapes as Kentkart serves them. Numbers and booleans often arrive as strings
// ("1"/"0"); the mapper coerces them. Field notes come from FKart-Rewritten/docs and the observer.

/** Every JSON response carries this envelope; `code` 0 means OK. */
export interface KentkartEnvelope {
	result?: {
		code?: number | string
		message?: string
		authType?: string
		cmd?: string
		dateTime?: string
	}
}

/** `GET {api}/route/list?region=` item. */
export interface KentkartRouteListItem {
	agencyId?: string | number
	agencyName?: string
	displayRouteCode: string
	name: string
	routeCode: string | number
	/** "route" for real lines; other values are POIs and similar. */
	type?: string
	routeType?: string | number
	routeColor?: string
	routeTextColor?: string
}

export interface KentkartRouteListResponse extends KentkartEnvelope {
	routeList?: KentkartRouteListItem[]
}

export interface KentkartPoint {
	seq: string | number
	lat: string | number
	lng: string | number
}

export interface KentkartBusStop extends KentkartPoint {
	stopId: string | number
	stopName: string
	/** Offset from the trip start, seconds as a string (or "HH:MM[:SS]" on some regions). */
	arrival_offset?: string | number | null
	departure_offset?: string | number | null
	routes?: string
	busOnStop?: "1" | "0"
	stopCode?: string
}

export interface KentkartTimeListItem {
	departureTime: string
	tripId: string | number
	patternColor?: string
	tripHeadSign?: string
	wheelChairId?: string
}

export interface KentkartSchedule {
	/** Capital letters mark active days, e.g. "MTWTFss" (weekdays), "mtwtfSs", "mtwtfsS". */
	description: string
	serviceId: string | number
	timeList?: KentkartTimeListItem[]
}

/** One direction of one route from `GET {web}/pathInfo`. */
export interface KentkartPath {
	direction: string | number
	direction_name?: string
	displayRouteCode: string
	headSign?: string
	path_code: string | number
	pointList?: KentkartPoint[]
	busStopList?: KentkartBusStop[]
	scheduleList?: KentkartSchedule[]
	timeTableList?: KentkartTimeListItem[]
	tripShortName?: string
}

export interface KentkartPathInfoResponse extends KentkartEnvelope {
	pathList?: KentkartPath[]
}

/** `GET {api}/v2.0/city` item (KentKartJS fetchCityList). */
export interface KentkartCity {
	id: string
	name: string
	lat?: string
	lon?: string
	visible?: string | number
	timezone?: string
}

export interface KentkartCityResponse extends KentkartEnvelope {
	city?: KentkartCity[]
}

/** `POST {auth}/oauth/token` answer. */
export interface KentkartTokenResponse extends KentkartEnvelope {
	accessToken?: string
	refreshToken?: string
	expiresIn?: number | string
}
