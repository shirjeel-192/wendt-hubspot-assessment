/**
 * Row -> HubSpot property maps for each entity type.
 *
 * These are the ONLY functions in the codebase that know both the source
 * (CSV/Airtable) field names and HubSpot's canonical property names. Keep
 * them small, testable, and free of any I/O.
 *
 * Every mapper also computes a "coercion audit" — pairs of (field, issue)
 * that the caller records via metrics.issue(). We collect issues instead
 * of throwing so a single bad field doesn't kill an otherwise-good row.
 */

import {
  coerceBool,
  coerceDate,
  coerceAmount,
  coercePercent,
  coercePhone,
  coerceInt,
  coerceString,
  coerceEnum,
  boolForHubspot,
  CoercionError,
} from "./clean.js";
import {
  CompanyRow,
  ContactRow,
  DealRow,
  EXTERNAL_ID_PROP,
  LIFECYCLE_STAGES,
  PREFERRED_CONTACT_METHODS,
  LEAD_SOURCES,
  DEAL_TYPES,
  REGIONS,
  HUBSPOT_DEAL_STAGES,
} from "./schemas.js";

export interface MapResult {
  externalId: string;
  properties: Record<string, string | number | boolean | null>;
  issues: { field: string; message: string; raw: unknown }[];
}

/** Wraps a coerce call and captures the error into an issue list. */
function safe<T>(
  issues: MapResult["issues"],
  fn: () => T | null,
  fieldName: string
): T | null {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CoercionError) {
      issues.push({ field: e.field, message: e.message, raw: e.rawValue });
      return null;
    }
    throw e;
  }
}

// ------------------------------------------------------------------
// COMPANY
// ------------------------------------------------------------------

export function mapCompany(row: CompanyRow): MapResult {
  const issues: MapResult["issues"] = [];
  const externalId = row.company_id;

  const props: Record<string, string | number | boolean | null> = {
    [EXTERNAL_ID_PROP]: externalId,
    name: coerceString("company_name", row.company_name),
    domain: coerceString("domain", row.domain),
    // HubSpot's built-in `industry` is a fixed enum (TELECOMMUNICATIONS, etc.).
    // The CSV's human-friendly values ("Telecom", "Biotech") don't match, so
    // we preserve them in a custom `industry_source` property instead. A
    // separate portal-side reconciliation pass can normalise these to the
    // canonical HubSpot industry list later if needed.
    industry_source: coerceString("industry", row.industry),
    numberofemployees: safe(issues, () => coerceInt("number_of_employees", row.number_of_employees), "number_of_employees"),
    // custom properties (created by scripts/bootstrap_hubspot.ts)
    is_customer: boolForHubspot(safe(issues, () => coerceBool("is_customer", row.is_customer), "is_customer")),
    is_key_account: boolForHubspot(safe(issues, () => coerceBool("is_key_account", row.is_key_account), "is_key_account")),
    account_manager: coerceString("account_manager", row.account_manager),
    // date properties — HubSpot accepts ms-since-epoch (integer)
    created_date_custom: safe(issues, () => coerceDate("created_date", row.created_date), "created_date"),
    renewal_date: safe(issues, () => coerceDate("renewal_date", row.renewal_date), "renewal_date"),
  };

  return { externalId, properties: props, issues };
}

// ------------------------------------------------------------------
// CONTACT
// ------------------------------------------------------------------

export function mapContact(row: ContactRow): MapResult {
  const issues: MapResult["issues"] = [];
  const externalId = row.contact_id;

  const props: Record<string, string | number | boolean | null> = {
    [EXTERNAL_ID_PROP]: externalId,
    firstname: coerceString("first_name", row.first_name),
    lastname: coerceString("last_name", row.last_name),
    email: coerceString("email", row.email),
    phone: safe(issues, () => coercePhone("phone", row.phone), "phone"),
    lifecyclestage: safe(
      issues,
      () => coerceEnum("lifecycle_stage", row.lifecycle_stage, LIFECYCLE_STAGES),
      "lifecycle_stage"
    ),
    // custom properties
    is_subscribed: boolForHubspot(safe(issues, () => coerceBool("is_subscribed", row.is_subscribed), "is_subscribed")),
    is_decision_maker: boolForHubspot(safe(issues, () => coerceBool("is_decision_maker", row.is_decision_maker), "is_decision_maker")),
    lead_source: safe(
      issues,
      () => coerceEnum("lead_source", row.lead_source, LEAD_SOURCES),
      "lead_source"
    ),
    preferred_contact_method: safe(
      issues,
      () => coerceEnum("preferred_contact_method", row.preferred_contact_method, PREFERRED_CONTACT_METHODS),
      "preferred_contact_method"
    ),
  };

  return { externalId, properties: props, issues };
}

// ------------------------------------------------------------------
// DEAL
// ------------------------------------------------------------------

export function mapDeal(row: DealRow): MapResult {
  const issues: MapResult["issues"] = [];
  const externalId = row.deal_id;

  // The Part-1 CSV `deal_stage` column already contains HubSpot's canonical
  // stage internal names (closedwon, contractsent, etc.), so we just
  // whitelist-validate rather than remap. Airtable middleware (Part 2)
  // does the human-readable Won/Lost -> canonical mapping — see
  // mapAirtableDealStage() below.
  const dealStage = safe(
    issues,
    () => coerceEnum("deal_stage", row.deal_stage, HUBSPOT_DEAL_STAGES),
    "deal_stage"
  );

  const props: Record<string, string | number | boolean | null> = {
    [EXTERNAL_ID_PROP]: externalId,
    dealname: coerceString("deal_name", row.deal_name),
    amount: safe(issues, () => coerceAmount("amount", row.amount), "amount"),
    dealstage: dealStage,
    closedate: safe(issues, () => coerceDate("close_date", row.close_date), "close_date"),
    // custom properties
    is_won: boolForHubspot(safe(issues, () => coerceBool("is_won", row.is_won), "is_won")),
    deal_type: safe(issues, () => coerceEnum("deal_type", row.deal_type, DEAL_TYPES), "deal_type"),
    region: safe(issues, () => coerceEnum("region", row.region, REGIONS), "region"),
    discount_percentage: safe(
      issues,
      () => coercePercent("discount_percentage", row.discount_percentage),
      "discount_percentage"
    ),
  };

  return { externalId, properties: props, issues };
}

// ------------------------------------------------------------------
// AIRTABLE DEAL STAGE (Part 2 spec: Won -> closedwon, Lost -> closedlost, else -> qualifiedtobuy).
// ------------------------------------------------------------------

export function mapAirtableDealStage(raw: string | null | undefined): string {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "won") return "closedwon";
  if (v === "lost") return "closedlost";
  return "qualifiedtobuy";
}
