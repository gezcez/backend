import { buildConfigurableMatrix } from "@gezcez/core"
import { text, int, uniqueIndex } from "drizzle-orm/sqlite-core"

export const {formsMatrixLogsTable,formsMatrixTable} = buildConfigurableMatrix({
	table_name: "forms",
	extra_columns: {
      form_key:text().notNull().unique(),
		form_description:text(),
   }
})


export const {form_fieldsMatrixLogsTable,form_fieldsMatrixTable} = buildConfigurableMatrix({
	table_name: "form_fields",
	extra_columns: {
		form_id: int().notNull().references(() => formsMatrixTable.id),
		field_key: text().notNull(),
		field_type: text().notNull().$type<"text" | "number" | "select" | "checkbox" | "radio">(),
	}
})

// Define unique index for form fields
export const formFieldsUniqueIndex = uniqueIndex("form_field_unique_idx").on(
	form_fieldsMatrixTable.form_id,
	form_fieldsMatrixTable.field_key
)