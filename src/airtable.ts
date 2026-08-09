/**
 * Thin Airtable wrapper.
 * The `airtable` npm client works, but its Promise API is quirky. Wrapping it
 * in typed functions makes the sync engine much easier to read.
 */

import Airtable, { FieldSet, Record as AirRecord } from "airtable";

export type AirtableTable = "Companies" | "Contacts" | "Deals" | "Line Items";

export interface AirtableRow {
  id: string;
  fields: Record<string, unknown>;
}

export class AirtableClient {
  private base: Airtable.Base;

  constructor(apiKey: string, baseId: string) {
    Airtable.configure({ apiKey });
    this.base = Airtable.base(baseId);
  }

  async get(table: AirtableTable, recordId: string): Promise<AirtableRow> {
    const rec: AirRecord<FieldSet> = await this.base(table).find(recordId);
    return { id: rec.id, fields: rec.fields as Record<string, unknown> };
  }

  async update(
    table: AirtableTable,
    recordId: string,
    fields: Record<string, unknown>
  ): Promise<void> {
    await this.base(table).update(recordId, fields as Partial<FieldSet>);
  }

  /** Used by the batch backfill script to list a whole table. */
  async listAll(table: AirtableTable): Promise<AirtableRow[]> {
    const rows: AirtableRow[] = [];
    await this.base(table)
      .select()
      .eachPage((records, next) => {
        for (const r of records) rows.push({ id: r.id, fields: r.fields as Record<string, unknown> });
        next();
      });
    return rows;
  }
}

/**
 * Airtable's schema uses human-friendly field names in the assessment spec.
 * These constants are the single source of truth — change here if the
 * base column names differ from the defaults.
 */
export const AIRTABLE_FIELDS = {
  companies: {
    name: "Company Name",
    domain: "Domain",
    industry: "Industry",
    hubspotRecordId: "hubspot_record_id",
    linkedContacts: "Contacts",
    linkedDeals: "Deals",
  },
  contacts: {
    firstName: "First Name",
    lastName: "Last Name",
    email: "Email",
    phone: "Phone",
    company: "Company",
    hubspotRecordId: "hubspot_record_id",
  },
  deals: {
    name: "Deal Name",
    amount: "Amount",
    stage: "Deal Stage",
    closeDate: "Close Date",
    company: "Company",
    hubspotRecordId: "hubspot_record_id",
    linkedLineItems: "Line Items",
  },
  lineItems: {
    productName: "Product Name",
    quantity: "Quantity",
    unitPrice: "Unit Price",
    deal: "Deal",
    hubspotRecordId: "hubspot_record_id",
  },
} as const;
