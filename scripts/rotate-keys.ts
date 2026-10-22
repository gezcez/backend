// rotate-keys.ts
// Adds a new signing key (active in 24 h) and schedules the current one to retire 30 days later.
// Run quarterly: `bun run keys:rotate`.

import "reflect-metadata"
import { NestFactory } from "@nestjs/core"
import { loadConfig } from "@common/config"
import { KeysService } from "@services/oauth/keys.service"
import { AppModule } from "../src/app.module"

const config = loadConfig()
const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), { logger: false })
const keys = app.get(KeysService)
const { kid } = await keys.rotate()
console.log(`New signing key ${kid} activates in 24 h; previous keys retire 30 days after that.`)
console.log(
	`Published keys: ${keys
		.jwks()
		.keys.map((key) => key.kid)
		.join(", ")}`,
)
await app.close()
