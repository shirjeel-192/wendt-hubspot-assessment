/**
 * Part 1 entry point: one-shot HubSpot migration from three CSVs.
 *
 * Ordering (this is load-bearing):
 *   1. Companies first — no dependencies.
 *   2. Contacts second — depend on companies for the contact->company assoc.
 *   3. Deals last — depend on both companies (deal->company) and contacts
 *      (deal->contact).
 *
 * Idempotency:
 *   Every entity carries a custom `external_id` property that stores its
 *   source-CSV primary key. Before creating, we look up existing records
 *   by external_id and split into (existing → update) and (new → create).
 *   Re-running the script against a HubSpot instance that already has
 *   some/all of the data is safe and cheap.
 *
 * Dry-run:
 *   DRY_RUN=1 loads/cleans/maps everything and prints what would go over
 *   the wire but does not hit HubSpot at all. Useful for verifying the
 *   coercion layer before pointing this at a sandbox.
 *
 * Output:
 *   Writes a full audit JSON to migration_data/audit-<timestamp>.json
 *   including per-field coercion counts, orphan/mismatch counts, and the
 *   list of rows that had any issues at all.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv } from "./env.js";
import { logger } from "./logger.js";
import { metrics } from "./metrics.js";
import { loadCsv } from "./csvLoader.js";
import {
  CompanyRow,
  CompanyRowSchema,
  ContactRow,
  ContactRowSchema,
  DealRow,
  DealRowSchema,
} from "./schemas.js";
import { mapCompany, mapContact, mapDeal, MapResult } from "./mappers.js";
import { ASSOC_TYPE, HubspotClient } from "./hubspot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CSV_DIR = path.join(REPO_ROOT, "migration_data");

async function main() {
  const env = loadEnv();
  const dryRun = env.DRY_RUN;
  const limit = env.MIGRATE_LIMIT;

  logger.info({ dryRun, limit: limit ?? "none" }, "starting migration");

  // ------------------------------------------------------------------
  // Load & validate CSV rows (raw string schemas).
  // ------------------------------------------------------------------
  const companies = loadRows<CompanyRow>(CompanyRowSchema, path.join(CSV_DIR, "companies.csv"), limit);
  const contacts = loadRows<ContactRow>(ContactRowSchema, path.join(CSV_DIR, "contacts.csv"), limit);
  const deals = loadRows<DealRow>(DealRowSchema, path.join(CSV_DIR, "deals.csv"), limit);
  logger.info(
    { companies: companies.length, contacts: contacts.length, deals: deals.length },
    "csv rows loaded"
  );

  // ------------------------------------------------------------------
  // Referential integrity check (before we hit HubSpot).
  // ------------------------------------------------------------------
  const companyIdSet = new Set(companies.map((c) => c.company_id));
  const contactIdSet = new Set(contacts.map((c) => c.contact_id));

  for (const c of contacts) {
    if (c.company_id && !companyIdSet.has(c.company_id)) {
      metrics.issue("orphan_contact_company", c.contact_id, `company_id ${c.company_id} not in companies`);
    }
  }
  for (const d of deals) {
    if (d.company_id && !companyIdSet.has(d.company_id)) {
      metrics.issue("orphan_deal_company", d.deal_id, `company_id ${d.company_id} not in companies`);
    }
    if (d.contact_id && !contactIdSet.has(d.contact_id)) {
      metrics.issue("orphan_deal_contact", d.deal_id, `contact_id ${d.contact_id} not in contacts`);
    }
  }
  logger.info(
    {
      orphan_contact_company: (metrics.snapshot().counters.issues?.orphan_contact_company ?? 0),
      orphan_deal_company: (metrics.snapshot().counters.issues?.orphan_deal_company ?? 0),
      orphan_deal_contact: (metrics.snapshot().counters.issues?.orphan_deal_contact ?? 0),
    },
    "referential integrity check complete"
  );

  // ------------------------------------------------------------------
  // Map (coerce + validate) rows to HubSpot property payloads.
  // ------------------------------------------------------------------
  const companyMapped = companies.map(mapCompany);
  const contactMapped = contacts.map(mapContact);
  const dealMapped = deals.map(mapDeal);

  recordIssues("companies", companyMapped);
  recordIssues("contacts", contactMapped);
  recordIssues("deals", dealMapped);

  if (dryRun) {
    logger.info("DRY_RUN=1, skipping HubSpot writes");
    logger.info({ sample_company: companyMapped[0] }, "sample mapped company");
    logger.info({ sample_contact: contactMapped[0] }, "sample mapped contact");
    logger.info({ sample_deal: dealMapped[0] }, "sample mapped deal");
    writeAudit();
    return;
  }

  // ------------------------------------------------------------------
  // Push to HubSpot.
  // ------------------------------------------------------------------
  const hs = new HubspotClient(env.HUBSPOT_ACCESS_TOKEN);

  // Companies
  const companyExtToHs = await upsertBatch(hs, "companies", companyMapped);
  // Contacts
  const contactExtToHs = await upsertBatch(hs, "contacts", contactMapped);
  // Deals
  const dealExtToHs = await upsertBatch(hs, "deals", dealMapped);

  // Associations
  const contactAssocs = contacts
    .filter((c) => c.company_id && contactExtToHs.has(c.contact_id) && companyExtToHs.has(c.company_id))
    .map((c) => ({
      from: { id: contactExtToHs.get(c.contact_id)! },
      to: { id: companyExtToHs.get(c.company_id!)! },
      types: [{ associationCategory: "HUBSPOT_DEFINED" as const, associationTypeId: ASSOC_TYPE.contact_to_company }],
    }));
  await hs.batchAssociate("contacts", "companies", contactAssocs);
  logger.info({ n: contactAssocs.length }, "contact -> company associations created");

  const dealCoAssocs = deals
    .filter((d) => d.company_id && dealExtToHs.has(d.deal_id) && companyExtToHs.has(d.company_id))
    .map((d) => ({
      from: { id: dealExtToHs.get(d.deal_id)! },
      to: { id: companyExtToHs.get(d.company_id!)! },
      types: [{ associationCategory: "HUBSPOT_DEFINED" as const, associationTypeId: ASSOC_TYPE.deal_to_company }],
    }));
  await hs.batchAssociate("deals", "companies", dealCoAssocs);
  logger.info({ n: dealCoAssocs.length }, "deal -> company associations created");

  const dealCtAssocs = deals
    .filter((d) => d.contact_id && dealExtToHs.has(d.deal_id) && contactExtToHs.has(d.contact_id))
    .map((d) => ({
      from: { id: dealExtToHs.get(d.deal_id)! },
      to: { id: contactExtToHs.get(d.contact_id!)! },
      types: [{ associationCategory: "HUBSPOT_DEFINED" as const, associationTypeId: ASSOC_TYPE.deal_to_contact }],
    }));
  await hs.batchAssociate("deals", "contacts", dealCtAssocs);
  logger.info({ n: dealCtAssocs.length }, "deal -> contact associations created");

  writeAudit();
  logger.info(metrics.snapshot().counters, "migration complete");
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function loadRows<T>(schema: { parse: (v: unknown) => T }, filePath: string, limit?: number): T[] {
  const raw = loadCsv(filePath);
  const rows = raw.map((r) => schema.parse(r));
  return limit ? rows.slice(0, limit) : rows;
}

function recordIssues(bucket: string, results: MapResult[]): void {
  let rowsWithIssues = 0;
  for (const r of results) {
    if (r.issues.length === 0) continue;
    rowsWithIssues++;
    for (const iss of r.issues) {
      metrics.inc(`${bucket}_coercion_issues`, iss.field);
    }
  }
  metrics.inc("summary", `${bucket}_rows_with_issues`, rowsWithIssues);
}

async function upsertBatch(
  hs: HubspotClient,
  objectType: "companies" | "contacts" | "deals",
  mapped: MapResult[]
): Promise<Map<string, string>> {
  const externalIds = mapped.map((m) => m.externalId);
  const existing = await hs.findByExternalIdBatch(objectType, externalIds);

  const toCreate: MapResult[] = [];
  const toUpdate: { id: string; result: MapResult }[] = [];
  for (const m of mapped) {
    const hit = existing.get(m.externalId);
    if (hit) toUpdate.push({ id: hit, result: m });
    else toCreate.push(m);
  }
  logger.info(
    { objectType, create: toCreate.length, update: toUpdate.length },
    "upsert plan"
  );

  const createRes = await hs.batchCreate(
    objectType,
    toCreate.map((m) => ({ properties: m.properties }))
  );
  const updateRes = await hs.batchUpdate(
    objectType,
    toUpdate.map((u) => ({ id: u.id, properties: u.result.properties }))
  );

  const out = new Map<string, string>(existing);
  // Map new HubSpot ids back to their external ids via the returned properties.
  for (const r of createRes) {
    const ext = r.properties?.external_id;
    if (ext) out.set(String(ext), String(r.id));
  }
  for (const r of updateRes) {
    const ext = r.properties?.external_id;
    if (ext) out.set(String(ext), String(r.id));
  }

  metrics.inc("summary", `${objectType}_created`, createRes.length);
  metrics.inc("summary", `${objectType}_updated`, updateRes.length);
  return out;
}

function writeAudit(): void {
  const snap = metrics.snapshot();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(CSV_DIR, `audit-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(snap, null, 2));
  logger.info({ outPath }, "wrote audit");
}

main().catch((err) => {
  logger.error({ err: err?.message, stack: err?.stack }, "migration failed");
  process.exit(1);
});
