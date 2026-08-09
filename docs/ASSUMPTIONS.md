# Assumptions

Documenting the judgment calls I made and why. Every one of these is a place where reasonable engineers could disagree — happy to revisit any of them on the call.

## Data-cleaning assumptions

### 1. Booleans normalise to `"true"` / `"false"` strings

The CSVs mix `1`, `0`, `True`, `False`, `Yes`, `No`. All get folded to boolean, then serialised to `"true"` / `"false"` for HubSpot (which accepts both the raw boolean and the string form, but the REST docs specify strings).

### 2. Dates default to US MM/DD/YYYY when ambiguous

`14/05/2021` is unambiguously DD/MM (day > 12). `04/06/2024` is ambiguous — could be April 6 or June 4. I default to US MM/DD/YYYY (matching HubSpot's US-market convention) and note the ambiguity in this doc. If it turns out Wendt's clients are UK/EU-first, this rule flips in `clean.ts::coerceDate`.

### 3. Partial dates (MM/YYYY) pin to the 1st of the month

`02/2024` becomes `2024-02-01`. Any downstream reporting will show these as "start of month" — arguably correct for a "created in this month" semantic, arguably wrong for a "renewal date" (a renewal on the 1st isn't the same as "sometime in the month"). Flagged for operator review.

### 4. Phone numbers pad the fake 555 prefix

Input phones are all in the US-directory-block `555` range but only carry 4 unique digits per row (`5550422`, `555-0245`, etc.). The area code (typically 3 digits before the 555) is missing entirely, so I pad with a second `555` to get valid E.164 length. Output is deterministic — `555-0422`, `+1-555-0422`, and `(555) 0422` all fold to `+15555550422`.

### 5. Amount is a plain number, not a string

Some HubSpot integrations send `"48469"`; the API accepts both. Sending a number keeps the JSON smaller and dodges locale-formatting bugs.

### 6. Percent stays as 0–100, not 0–1

HubSpot's number properties don't have a "percent" type — they're just numbers with an optional `%` suffix in the UI. I keep the 0–100 range that matches the raw CSV values (`20`, `15%` → `20`, `15`) so the HubSpot column reads the same as the CSV.

### 7. Enum coercion is case-insensitive but the OUTPUT uses canonical casing

`amer` → `AMER`, `TRADE SHOW` → `Trade Show`. HubSpot enum options are case-sensitive on save, and we want the canonical casing everywhere. Unknown enum values throw `CoercionError` — the row goes through with the field null, and the audit records that we hit a new enum member.

## Schema assumptions

### 8. `external_id` (source primary key) is a text property on all three object types

Created by `scripts/bootstrap_hubspot.ts`. This is what lets us re-run the migration idempotently. If Wendt has a preferred external-id property name (e.g. `wp_source_id`), the value in `src/schemas.ts::EXTERNAL_ID_PROP` is the single point of change.

### 9. `created_date_custom`, not `createdate`

HubSpot's built-in `createdate` is read-only. To preserve the source system's create date, I use a distinct custom property. If the intent is "the CSV's created_date should overwrite HubSpot's createdate", that's not directly possible — HubSpot ignores writes to that field.

### 10. Deal-stage internal names are the standard HubSpot Sales Pipeline

The Part 1 CSV `deal_stage` column has values like `closedwon`, `contractsent`, `qualifiedtobuy` — these are the internal names of the default HubSpot Sales Pipeline. If Wendt uses a custom pipeline with different internal names, `src/schemas.ts::HUBSPOT_DEAL_STAGES` needs updating and the migration will surface unknown stages as coercion errors instead of silently pushing invalid data.

## Migration assumptions

### 11. Companies → Contacts → Deals ordering is enforced sequentially

Contacts can be associated to companies only after the companies exist. Deals need both companies and contacts. The migration script does them serially at the entity level; within each entity, batches run concurrently (up to 4 in flight, limited by `p-limit`).

### 12. Orphan foreign keys don't block the record itself

A contact with `company_id=307` when company 307 doesn't exist still gets created in HubSpot as an unassociated contact. The audit records the orphan. If the ask is "reject the whole row" instead of "create-and-flag", one line in `migrate.ts` changes.

### 13. Re-running the migration is safe

The `external_id` lookup + upsert pattern means the second run just updates whatever's already there. New rows added to the CSV get created. Rows removed from the CSV do NOT get deleted from HubSpot — deletion is a manual operator decision.

## Middleware assumptions

### 14. `hubspot_record_id` in Airtable is the idempotency lock

Any Airtable row without this field is treated as "not yet in HubSpot". Setting the field manually to a valid HubSpot id will make the next webhook do an update instead of a create — useful for a manual reconciliation.

### 15. One-way sync (Airtable → HubSpot)

Adding the reverse direction is a straight follow-up: HubSpot supports webhooks for object property changes. The mapper + client are already source-agnostic; a `hubspotToAirtable.ts` module and a `POST /webhook/hubspot` route would complete it. Out of scope for this assessment.

### 16. Line-item association type is `HUBSPOT_DEFINED` id 20

Verified on the current v4 API. If HubSpot revs the id (they've done this once for deal-line-item associations), the lookup would need to move to `GET /crm/v4/associations/line_items/deals/labels`.

### 17. Airtable's built-in "Send webhook" Automation is enough

No HMAC signing. Shared secret in the query string, compared in constant time. For an actual production system handling contract-value data, I'd move to the Airtable Webhooks API which supports HMAC.

### 18. The middleware runs single-instance for now

The `inFlight` Map in `sync.ts` is process-local. If we scale to N replicas, that lock stops working. Mitigation is Redis (see ARCHITECTURE.md) — a 10-line change.

## What I would ask on the call

1. **Is Wendt's HubSpot portal on a US or EU-first date convention?** Answers the DD/MM/YYYY ambiguity question.
2. **Do the target HubSpot properties for `deal_stage` come from the default pipeline or a custom one?** Determines whether the whitelist in `schemas.ts` is right.
3. **Is line-item sync in scope for the assessment answer?** The middleware handles it, but the migration script doesn't (no line-items CSV was provided).
4. **Is the ~40 K/100 K CSV row scale representative, or is the real migration 10–100× bigger?** Affects whether we stay on the sync batch endpoints or move to the async batch v2 endpoints for the migration.
5. **What's the deletion policy?** Neither part currently deletes anything on the HubSpot side. If a row disappears from the CSV / Airtable, should we tombstone the HubSpot record?
