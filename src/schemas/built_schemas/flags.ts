import { buildConfigurableMatrix } from "@gezcez/core";
import { int, text } from "drizzle-orm/sqlite-core";

export const {flagsMatrixLogsTable,flagsMatrixTable} = buildConfigurableMatrix({
   table_name: "flags",
   extra_columns: {
      key:text().notNull().unique(),
      value:int({mode:"boolean"}).notNull()  
   }
})