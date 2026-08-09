/**
 * Command-line one-shot sync for a single Airtable record.
 *
 * Usage:
 *   pnpm run sync Companies recXXXXXXXXXXXX
 *
 * Handy for smoke-testing the sync engine against a specific record without
 * running the whole webhook server. Same code path — just a different entry.
 */

import { loadEnv } from "./env.js";
import { logger } from "./logger.js";
import { AirtableClient, AirtableTable } from "./airtable.js";
import { HubspotClient } from "./hubspot.js";
import { syncRecord } from "./sync.js";

async function main() {
  const [, , table, recordId] = process.argv;
  if (!table || !recordId) {
    console.error("usage: sync-cli.ts <table> <recordId>");
    process.exit(2);
  }
  const env = loadEnv({ requireAirtable: true });
  const airtable = new AirtableClient(env.AIRTABLE_API_KEY!, env.AIRTABLE_BASE_ID!);
  const hubspot = new HubspotClient(env.HUBSPOT_ACCESS_TOKEN);
  const hubspotId = await syncRecord({ airtable, hubspot }, table as AirtableTable, recordId);
  logger.info({ hubspotId }, "sync done");
}

main().catch((err) => {
  logger.error({ err: err?.message, stack: err?.stack, resp: err?.response?.data }, "sync-cli failed");
  process.exit(1);
});
