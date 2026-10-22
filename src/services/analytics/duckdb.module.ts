// duckdb.module.ts
// The process-wide DuckDB instance, shared by the archive export and the analytics module.

import { Global, Module } from "@nestjs/common"
import { DuckDBService } from "./duckdb.service"

@Global()
@Module({ providers: [DuckDBService], exports: [DuckDBService] })
export class DuckDbModule {}
