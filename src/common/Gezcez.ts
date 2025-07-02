export function GezcezResponse(
	data: { [key: string]: any; __message?: string },
	status?: number
) {
	return {
		result: {
			success: (status || 200) === 200,
			status: status || 200,
			time: Date.now(),
			formatted_time: new Date().toISOString(),
			message: data.__message || "OK",
		},
		...data,
		__message: undefined,
	}
}
