import type { ExtractArgsObjectWithTypeSafety, FlattenKeys, GetValueFromFlattenRecord } from "../../types/type-helpers";
import { buildConfig } from ".";
import { LANG_TR } from "@lang/tr";
import { LANG_EN } from "@lang/en";

const LANGS = {
	TR: LANG_TR,
	EN: LANG_EN,
} as const;

export function TranslatedKeyword<
	LANG extends keyof typeof LANGS,
	KEY extends FlattenKeys<typeof LANGS[keyof typeof LANGS]>
>(
	lang: LANG,
	key: KEY,
	args: ExtractArgsObjectWithTypeSafety<GetValueFromFlattenRecord<typeof LANGS[LANG],KEY>>
) {

}

const translated_parse_error = TranslatedKeyword("TR","Responses.VALIDATION_FAILED",{parse_key:"",parse_type:""})