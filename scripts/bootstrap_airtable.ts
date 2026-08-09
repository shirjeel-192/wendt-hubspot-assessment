/**
 * Creates the 4 tables (Companies, Contacts, Deals, Line Items) in the
 * Airtable base via the Meta API. Idempotent — checks existing tables first.
 *
 * Requires the token to have scope schema.bases:write.
 *
 * Linked-record fields need two-step creation: create Companies + Contacts
 * first with their non-link fields, then add the link fields on both sides.
 * Airtable's Meta API auto-creates the reverse link on the linked table.
 */

import axios from "axios";
import { loadEnv } from "../src/env.js";
import { logger } from "../src/logger.js";

const env = loadEnv({ requireAirtable: true });
const META_URL = `https://api.airtable.com/v0/meta/bases/${env.AIRTABLE_BASE_ID}`;
const headers = { Authorization: `Bearer ${env.AIRTABLE_API_KEY}` };

interface AirtableField {
  name: string;
  type: string;
  options?: Record<string, unknown>;
}

async function listTables(): Promise<{ id: string; name: string; fields: { name: string; id: string }[] }[]> {
  const res = await axios.get(`${META_URL}/tables`, { headers });
  return res.data.tables;
}

async function createTable(name: string, primaryFieldName: string, fields: AirtableField[]): Promise<string> {
  const res = await axios.post(
    `${META_URL}/tables`,
    { name, fields: [{ name: primaryFieldName, type: "singleLineText" }, ...fields] },
    { headers }
  );
  logger.info({ name, id: res.data.id }, "created Airtable table");
  return res.data.id;
}

async function addField(tableId: string, field: AirtableField): Promise<void> {
  await axios.post(`${META_URL}/tables/${tableId}/fields`, field, { headers });
  logger.info({ tableId, field: field.name }, "added Airtable field");
}

async function main() {
  const existing = await listTables();
  const byName = new Map(existing.map((t) => [t.name, t]));
  logger.info({ tables: existing.map((t) => t.name) }, "existing tables");

  // 1. Companies (no link fields yet)
  let companiesId = byName.get("Companies")?.id;
  if (!companiesId) {
    companiesId = await createTable("Companies", "Company Name", [
      { name: "Domain", type: "url" },
      { name: "Industry", type: "singleLineText" },
      { name: "hubspot_record_id", type: "singleLineText" },
    ]);
  }

  // 2. Contacts (link to Companies)
  let contactsId = byName.get("Contacts")?.id;
  if (!contactsId) {
    contactsId = await createTable("Contacts", "Email", [
      { name: "First Name", type: "singleLineText" },
      { name: "Last Name", type: "singleLineText" },
      { name: "Phone", type: "phoneNumber" },
      { name: "Company", type: "multipleRecordLinks", options: { linkedTableId: companiesId } },
      { name: "hubspot_record_id", type: "singleLineText" },
    ]);
  }

  // 3. Deals (link to Companies)
  let dealsId = byName.get("Deals")?.id;
  if (!dealsId) {
    dealsId = await createTable("Deals", "Deal Name", [
      { name: "Amount", type: "currency", options: { precision: 2, symbol: "$" } },
      {
        name: "Deal Stage",
        type: "singleSelect",
        options: {
          choices: [
            { name: "Won" },
            { name: "Lost" },
            { name: "Negotiation" },
            { name: "Pending" },
          ],
        },
      },
      { name: "Close Date", type: "date", options: { dateFormat: { name: "iso" } } },
      { name: "Company", type: "multipleRecordLinks", options: { linkedTableId: companiesId } },
      { name: "hubspot_record_id", type: "singleLineText" },
    ]);
  }

  // 4. Line Items (link to Deals)
  let lineItemsId = byName.get("Line Items")?.id;
  if (!lineItemsId) {
    lineItemsId = await createTable("Line Items", "Product Name", [
      { name: "Quantity", type: "number", options: { precision: 0 } },
      { name: "Unit Price", type: "currency", options: { precision: 2, symbol: "$" } },
      { name: "Deal", type: "multipleRecordLinks", options: { linkedTableId: dealsId } },
      { name: "hubspot_record_id", type: "singleLineText" },
    ]);
  }

  logger.info(
    { companies: companiesId, contacts: contactsId, deals: dealsId, lineItems: lineItemsId },
    "airtable bootstrap complete"
  );
  console.log(`\nOpen your base: https://airtable.com/${env.AIRTABLE_BASE_ID}`);
}

main().catch((err) => {
  logger.error({ err: err?.message, resp: err?.response?.data }, "airtable bootstrap failed");
  process.exit(1);
});
