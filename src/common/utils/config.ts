import { IConfig } from "../types";
import { logger } from ".";
import { readFileSync } from "node:fs";
var imported: IConfig;
export function buildConfig() {
  if (imported) return imported;
  const config_path = process.env.CONFIG_PATH;
  if (!config_path)
    logger.warning(
      "utils.master: process.env.config_path is undefined, using the defaults"
    );
  imported = JSON.parse(
    readFileSync(
      config_path ||
        (process.env.NODE_ENV !== "PRODUCTION"
          ? "./volume/service.config.json"
          : "../service.config.json")
    ).toString()
  );
  return imported;
}
