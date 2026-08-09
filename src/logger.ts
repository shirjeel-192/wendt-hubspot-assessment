import pino from "pino";
import { loadEnv } from "./env.js";

/**
 * pino-pretty in dev (TTY), JSON lines in prod. Pretty output uses the same
 * timestamps as the JSON output so grep/jq stays useful.
 */
export const logger = pino({
  level: loadEnv().LOG_LEVEL,
  transport: process.stdout.isTTY
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
    : undefined,
});
