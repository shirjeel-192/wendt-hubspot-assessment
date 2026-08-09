/**
 * Creates the HubSpot custom properties this migration needs.
 * Idempotent — checks with GET before creating.
 *
 * Run this ONCE against a fresh HubSpot developer sandbox before the
 * first migration. It does NOT modify existing standard properties.
 */

import { loadEnv } from "../src/env.js";
import { logger } from "../src/logger.js";
import { HubspotClient } from "../src/hubspot.js";
import {
  DEAL_TYPES,
  LEAD_SOURCES,
  PREFERRED_CONTACT_METHODS,
  REGIONS,
  EXTERNAL_ID_PROP,
} from "../src/schemas.js";

async function main() {
  const env = loadEnv();
  const hs = new HubspotClient(env.HUBSPOT_ACCESS_TOKEN);

  // ---------- external_id on all three ----------
  for (const t of ["companies", "contacts", "deals"] as const) {
    await hs.ensureCustomProperty(t, {
      name: EXTERNAL_ID_PROP,
      label: "External ID (source system)",
      type: "string",
      fieldType: "text",
    });
  }

  // ---------- COMPANY custom props ----------
  await hs.ensureCustomProperty("companies", {
    name: "is_customer",
    label: "Is Customer",
    type: "bool",
    fieldType: "booleancheckbox",
  });
  await hs.ensureCustomProperty("companies", {
    name: "is_key_account",
    label: "Is Key Account",
    type: "bool",
    fieldType: "booleancheckbox",
  });
  await hs.ensureCustomProperty("companies", {
    name: "account_manager",
    label: "Account Manager",
    type: "string",
    fieldType: "text",
  });
  // NOTE: HubSpot has a built-in `createdate` we cannot overwrite, so we use
  // a distinct `created_date_custom` property for the source system's
  // record-creation date.
  await hs.ensureCustomProperty("companies", {
    name: "created_date_custom",
    label: "Source Created Date",
    type: "date",
    fieldType: "date",
  });
  await hs.ensureCustomProperty("companies", {
    name: "renewal_date",
    label: "Renewal Date",
    type: "date",
    fieldType: "date",
  });

  // ---------- CONTACT custom props ----------
  await hs.ensureCustomProperty("contacts", {
    name: "is_subscribed",
    label: "Is Subscribed",
    type: "bool",
    fieldType: "booleancheckbox",
  });
  await hs.ensureCustomProperty("contacts", {
    name: "is_decision_maker",
    label: "Is Decision Maker",
    type: "bool",
    fieldType: "booleancheckbox",
  });
  await hs.ensureCustomProperty("contacts", {
    name: "lead_source",
    label: "Lead Source",
    type: "enumeration",
    fieldType: "select",
    options: LEAD_SOURCES.map((v) => ({ label: v, value: v })),
  });
  await hs.ensureCustomProperty("contacts", {
    name: "preferred_contact_method",
    label: "Preferred Contact Method",
    type: "enumeration",
    fieldType: "select",
    options: PREFERRED_CONTACT_METHODS.map((v) => ({ label: v, value: v })),
  });

  // ---------- DEAL custom props ----------
  await hs.ensureCustomProperty("deals", {
    name: "is_won",
    label: "Is Won",
    type: "bool",
    fieldType: "booleancheckbox",
  });
  await hs.ensureCustomProperty("deals", {
    name: "deal_type",
    label: "Deal Type",
    type: "enumeration",
    fieldType: "select",
    options: DEAL_TYPES.map((v) => ({ label: v, value: v })),
  });
  await hs.ensureCustomProperty("deals", {
    name: "region",
    label: "Region",
    type: "enumeration",
    fieldType: "select",
    options: REGIONS.map((v) => ({ label: v, value: v })),
  });
  await hs.ensureCustomProperty("deals", {
    name: "discount_percentage",
    label: "Discount Percentage",
    type: "number",
    fieldType: "number",
  });

  logger.info("bootstrap complete");
}

main().catch((err) => {
  logger.error({ err: err?.message, stack: err?.stack, resp: err?.response?.data }, "bootstrap failed");
  process.exit(1);
});
