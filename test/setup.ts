// Preloaded by bun test (bunfig.toml).
import "reflect-metadata"
import { setDefaultTimeout } from "bun:test"

process.env.NODE_ENV ??= "test"

// Hooks (app boot in beforeAll) default to 5 s, which a loaded CI runner can exceed.
setDefaultTimeout(30_000)
