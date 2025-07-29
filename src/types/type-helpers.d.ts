export type FlattenKeys<
	MAP extends Record<string, any>,
	PREFIX extends string = ""
> = MAP[keyof MAP] extends Record<string, any>
	? FlattenKeys<
			MAP[keyof MAP],
			`${PREFIX extends "" ? "" : `${PREFIX}.`}${keyof MAP}`
	  >
	: `${PREFIX extends "" ? "" : `${PREFIX}.`}${keyof MAP}`

export type ExtractArgsObjectWithTypeSafety<T extends string> = Record<
	StringBeforeSplitter<ExtractArgs<T>, ":">,
	StringToType<ExtractArgTypes<ExtractArgs<T>>>
>
type ExtractArgs<
	T extends string,
	ARGS extends string[] = []
> = T extends `${string}%${infer KEY extends string}%${infer REST extends string}`
	? ExtractArgs<REST, [KEY, ...ARGS]>
	: // : T extends `${string}%${infer KEY extends string}%${infer REST extends string}`
	  // ? ExtractArgs<undefined, [KEY, ...ARGS]>
	  ARGS[Omit<keyof ARGS>]

type ExtractArgTypes<
	T extends string[],
	ARGS extends string[] = []
> = SplitString<StringAfterSplitter<T[number], ":">, ":">

type SplitString<
	T extends string,
	SPLITTER extends string = ":",
	EXTRACTED extends string[] = []
> = T extends `${infer EXTRACT extends string}${SPLITTER}${infer REST extends string}`
	? SplitString<REST, SPLITTER, [...EXTRACTED, EXTRACT]>
	: [...EXTRACTED, T][number]
// : EXTRACTED
// : EXTRACTED[keyof EXTRACTED] extends string
// ? EXTRACTED[keyof EXTRACTED]
// : T extends string
// ? T
// : never
type StringToType<T extends string> = T extends "number"
	? number
	: T extends "boolean"
	? boolean
	: T
export type StringBeforeSplitter<
	KEY extends string,
	SPLITTER extends string = "."
> = KEY extends `${infer HEAD extends string}${SPLITTER}${infer REST extends string}`
	? HEAD
	: KEY
export type StringAfterSplitter<
	KEY extends string,
	SPLITTER extends string = "."
> = KEY extends `${infer HEAD extends string}${SPLITTER}${infer REST extends string}`
	? REST
	: KEY

export type GetValueFromFlattenRecord<
	RECORD extends Record<string, any>,
	KEY extends string
> = RECORD[KEY] extends string
	? RECORD[KEY]
	: GetValueFromFlattenRecord<
			RECORD[StringBeforeSplitter<KEY>],
			StringAfterSplitter<KEY>
	  >
