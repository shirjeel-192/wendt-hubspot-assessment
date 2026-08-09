/**
 * Input row schemas (raw CSV strings) and canonical entity shapes (post-clean).
 *
 * Every CSV field is a string at parse time (that's what csv-parse gives us),
 * so raw schemas just check "everything is a string, nothing's missing" —
 * the actual normalisation happens in clean.ts and is layered on top.
 */

import { z } from "zod";

// ------------------------------------------------------------------
// Raw row schemas — one per CSV, everything's a string.
// Trailing partial() means missing columns become undefined, not an error;
// the coercers already handle undefined/null uniformly.
// ------------------------------------------------------------------

export const CompanyRowSchema = z.object({
  company_id: z.string(),
  company_name: z.string(),
  domain: z.string().optional(),
  industry: z.string().optional(),
  number_of_employees: z.string().optional(),
  is_customer: z.string().optional(),
  created_date: z.string().optional(),
  account_manager: z.string().optional(),
  renewal_date: z.string().optional(),
  is_key_account: z.string().optional(),
});
export type CompanyRow = z.infer<typeof CompanyRowSchema>;

export const ContactRowSchema = z.object({
  contact_id: z.string(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  company_id: z.string().optional(),
  lifecycle_stage: z.string().optional(),
  is_subscribed: z.string().optional(),
  lead_source: z.string().optional(),
  preferred_contact_method: z.string().optional(),
  is_decision_maker: z.string().optional(),
});
export type ContactRow = z.infer<typeof ContactRowSchema>;

export const DealRowSchema = z.object({
  deal_id: z.string(),
  deal_name: z.string(),
  amount: z.string().optional(),
  deal_stage: z.string().optional(),
  close_date: z.string().optional(),
  company_id: z.string().optional(),
  contact_id: z.string().optional(),
  is_won: z.string().optional(),
  deal_type: z.string().optional(),
  region: z.string().optional(),
  discount_percentage: z.string().optional(),
});
export type DealRow = z.infer<typeof DealRowSchema>;

// ------------------------------------------------------------------
// Enum whitelists (extracted from a full distinct-values sweep — see
// docs/ASSUMPTIONS.md for how these were derived).
// ------------------------------------------------------------------

export const LIFECYCLE_STAGES = [
  "subscriber",
  "lead",
  "marketingqualifiedlead",
  "salesqualifiedlead",
  "opportunity",
  "customer",
  "evangelist",
] as const;

export const PREFERRED_CONTACT_METHODS = ["Email", "Phone", "SMS", "No Preference"] as const;

export const LEAD_SOURCES = [
  "Organic Search",
  "Referral",
  "Trade Show",
  "Cold Outreach",
  "Webinar",
  "Partner",
] as const;

export const DEAL_TYPES = ["New Business", "Renewal", "Upsell", "Cross-sell"] as const;

export const REGIONS = ["AMER", "EMEA", "APAC", "LATAM"] as const;

/** HubSpot's canonical Sales Pipeline stage internal names. */
export const HUBSPOT_DEAL_STAGES = [
  "appointmentscheduled",
  "qualifiedtobuy",
  "presentationscheduled",
  "decisionmakerboughtin",
  "contractsent",
  "closedwon",
  "closedlost",
] as const;

// ------------------------------------------------------------------
// External-id property names.
// hubspot_record_id lives in Airtable and holds the HubSpot record id
// once we've created it — idempotency lock. On the HubSpot side we use
// a custom `external_id` property that stores the CSV/Airtable primary
// key so we can look records up in either direction.
// ------------------------------------------------------------------

export const EXTERNAL_ID_PROP = "external_id";
