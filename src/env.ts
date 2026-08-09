import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  HUBSPOT_ACCESS_TOKEN: z.string().min(20, "HUBSPOT_ACCESS_TOKEN missing or too short"),

  AIRTABLE_API_KEY: z.string().optional(),
  AIRTABLE_BASE_ID: z.string().optional(),
  AIRTABLE_WEBHOOK_SECRET: z.string().optional(),

  PORT: z.coerce.number().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DRY_RUN: z
    .string()
    .default("0")
    .transform((v) => v === "1" || v.toLowerCase() === "true"),

  MIGRATE_LIMIT: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== "" ? Number(v) : undefined)),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Parse env at call site. Migrate script only needs HUBSPOT_* — server needs
 * AIRTABLE_* too. So `requireAirtable` is a runtime check, not a schema one.
 */
export function loadEnv(opts?: { requireAirtable?: boolean }): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Environment validation failed:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  if (opts?.requireAirtable) {
    const missing: string[] = [];
    if (!parsed.data.AIRTABLE_API_KEY) missing.push("AIRTABLE_API_KEY");
    if (!parsed.data.AIRTABLE_BASE_ID) missing.push("AIRTABLE_BASE_ID");
    if (missing.length) {
      console.error(`Airtable env vars missing: ${missing.join(", ")}`);
      process.exit(1);
    }
  }
  cached = parsed.data;
  return cached;
}
