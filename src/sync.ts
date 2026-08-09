/**
 * Sync engine for the Airtable -> HubSpot middleware.
 *
 * Contract:
 *   syncRecord(table, airtableRecordId) — fetches the record from Airtable,
 *   maps it to HubSpot properties, upserts (create-or-update based on the
 *   hubspot_record_id column), writes the id back to Airtable if we just
 *   created it, and handles any associations (contact->company, deal->company,
 *   line-item->deal).
 *
 * Idempotency:
 *   - hubspot_record_id column IS the idempotency lock. Presence means the
 *     record already exists in HubSpot; absence means we need to create it.
 *   - A per-recordId promise cache prevents two overlapping webhooks from
 *     both creating the record. The second call waits for the first to
 *     finish and then reads the freshly-written hubspot_record_id.
 *
 * What this does NOT try to do:
 *   - Two-way sync (HubSpot -> Airtable). One-way is enough for the assessment.
 *   - Delete propagation. Airtable "delete" events fire, but the middleware
 *     currently no-ops on them and logs a warning — HubSpot deletes should
 *     be operator-approved.
 *   - Cross-record dependency ordering. If a Deal webhook arrives before
 *     the Company it references has been synced, we sync the Company first
 *     (recursive fetch by Airtable link field).
 */

import { AirtableClient, AIRTABLE_FIELDS, AirtableRow, AirtableTable } from "./airtable.js";
import { HubspotClient, ASSOC_TYPE, ObjectType } from "./hubspot.js";
import {
  coerceAmount,
  coerceDate,
  coercePhone,
  coerceString,
} from "./clean.js";
import { mapAirtableDealStage } from "./mappers.js";
import { logger } from "./logger.js";

export interface SyncContext {
  airtable: AirtableClient;
  hubspot: HubspotClient;
}

/** In-flight cache keyed on Airtable record id (prevents double-create races). */
const inFlight = new Map<string, Promise<string | null>>();

export async function syncRecord(
  ctx: SyncContext,
  table: AirtableTable,
  airtableRecordId: string
): Promise<string | null> {
  const key = `${table}:${airtableRecordId}`;
  const existing = inFlight.get(key);
  if (existing) {
    logger.debug({ key }, "sync already in-flight, awaiting existing promise");
    return existing;
  }
  const promise = doSync(ctx, table, airtableRecordId).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function doSync(
  ctx: SyncContext,
  table: AirtableTable,
  airtableRecordId: string
): Promise<string | null> {
  const row = await ctx.airtable.get(table, airtableRecordId);
  logger.info({ table, airtableRecordId }, "sync start");

  switch (table) {
    case "Companies":
      return syncCompany(ctx, row);
    case "Contacts":
      return syncContact(ctx, row);
    case "Deals":
      return syncDeal(ctx, row);
    case "Line Items":
      return syncLineItem(ctx, row);
  }
}

// ------------------------------------------------------------------
// COMPANY
// ------------------------------------------------------------------
async function syncCompany(ctx: SyncContext, row: AirtableRow): Promise<string | null> {
  const F = AIRTABLE_FIELDS.companies;
  const properties = {
    name: coerceString("Company Name", row.fields[F.name] as string),
    domain: coerceString("Domain", row.fields[F.domain] as string),
    industry: coerceString("Industry", row.fields[F.industry] as string),
  };
  const existingId = row.fields[F.hubspotRecordId] as string | undefined;
  const hubspotId = await upsert(ctx.hubspot, "companies", existingId, properties);
  if (!existingId) {
    await ctx.airtable.update("Companies", row.id, { [F.hubspotRecordId]: hubspotId });
  }
  return hubspotId;
}

// ------------------------------------------------------------------
// CONTACT
// ------------------------------------------------------------------
async function syncContact(ctx: SyncContext, row: AirtableRow): Promise<string | null> {
  const F = AIRTABLE_FIELDS.contacts;
  const properties = {
    firstname: coerceString("First Name", row.fields[F.firstName] as string),
    lastname: coerceString("Last Name", row.fields[F.lastName] as string),
    email: coerceString("Email", row.fields[F.email] as string),
    phone: coercePhone("Phone", row.fields[F.phone] as string),
  };
  const existingId = row.fields[F.hubspotRecordId] as string | undefined;
  const hubspotId = await upsert(ctx.hubspot, "contacts", existingId, properties);
  if (!existingId) {
    await ctx.airtable.update("Contacts", row.id, { [F.hubspotRecordId]: hubspotId });
  }

  // Contact -> Company association (Airtable "Company" field is a linked-record array)
  const linkedCompany = firstLink(row.fields[F.company]);
  if (linkedCompany) {
    const companyHubspotId = await syncRecord(ctx, "Companies", linkedCompany);
    if (companyHubspotId && hubspotId) {
      await ctx.hubspot.batchAssociate("contacts", "companies", [
        {
          from: { id: hubspotId },
          to: { id: companyHubspotId },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: ASSOC_TYPE.contact_to_company,
            },
          ],
        },
      ]);
    }
  }
  return hubspotId;
}

// ------------------------------------------------------------------
// DEAL
// ------------------------------------------------------------------
async function syncDeal(ctx: SyncContext, row: AirtableRow): Promise<string | null> {
  const F = AIRTABLE_FIELDS.deals;
  const rawStage = coerceString("Deal Stage", row.fields[F.stage] as string);
  const properties = {
    dealname: coerceString("Deal Name", row.fields[F.name] as string),
    amount: coerceAmount("Amount", String(row.fields[F.amount] ?? "")),
    dealstage: mapAirtableDealStage(rawStage),
    closedate: coerceDate("Close Date", row.fields[F.closeDate] as string),
  };
  const existingId = row.fields[F.hubspotRecordId] as string | undefined;
  const hubspotId = await upsert(ctx.hubspot, "deals", existingId, properties);
  if (!existingId) {
    await ctx.airtable.update("Deals", row.id, { [F.hubspotRecordId]: hubspotId });
  }

  const linkedCompany = firstLink(row.fields[F.company]);
  if (linkedCompany) {
    const companyHubspotId = await syncRecord(ctx, "Companies", linkedCompany);
    if (companyHubspotId && hubspotId) {
      await ctx.hubspot.batchAssociate("deals", "companies", [
        {
          from: { id: hubspotId },
          to: { id: companyHubspotId },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: ASSOC_TYPE.deal_to_company,
            },
          ],
        },
      ]);
    }
  }
  return hubspotId;
}

// ------------------------------------------------------------------
// LINE ITEM
// HubSpot's line_items object type is real and associates to deals. We
// use the standard object type name "line_items" here.
// ------------------------------------------------------------------
async function syncLineItem(ctx: SyncContext, row: AirtableRow): Promise<string | null> {
  const F = AIRTABLE_FIELDS.lineItems;
  const properties = {
    name: coerceString("Product Name", row.fields[F.productName] as string),
    quantity: coerceAmount("Quantity", String(row.fields[F.quantity] ?? "")),
    price: coerceAmount("Unit Price", String(row.fields[F.unitPrice] ?? "")),
  };
  const existingId = row.fields[F.hubspotRecordId] as string | undefined;
  const hubspotId = await upsert(ctx.hubspot, "line_items" as ObjectType, existingId, properties);
  if (!existingId) {
    await ctx.airtable.update("Line Items", row.id, { [F.hubspotRecordId]: hubspotId });
  }

  const linkedDeal = firstLink(row.fields[F.deal]);
  if (linkedDeal) {
    const dealHubspotId = await syncRecord(ctx, "Deals", linkedDeal);
    if (dealHubspotId && hubspotId) {
      // Deal <-> Line Item association: HUBSPOT_DEFINED type id 20.
      await ctx.hubspot.batchAssociate("line_items" as ObjectType, "deals" as ObjectType, [
        {
          from: { id: hubspotId },
          to: { id: dealHubspotId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 20 }],
        },
      ]);
    }
  }
  return hubspotId;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function upsert(
  hs: HubspotClient,
  objectType: ObjectType,
  existingHubspotId: string | undefined,
  properties: Record<string, string | number | boolean | null>
): Promise<string | null> {
  if (existingHubspotId) {
    const updated = await hs.updateOne(objectType, existingHubspotId, properties);
    logger.debug({ objectType, id: updated.id }, "updated");
    return updated.id;
  }
  const created = await hs.createOne(objectType, properties);
  logger.info({ objectType, id: created.id }, "created");
  return created.id;
}

/**
 * Airtable linked-record fields come in as an array of record ids.
 * We take the first one; if a deal has multiple companies, only the primary
 * association is used (matches Wendt's assessment spec).
 */
function firstLink(v: unknown): string | undefined {
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
  return undefined;
}
