# Architecture

## Layers

```
┌──────────────────────────────────────────────────────────────────┐
│  Entry points                                                    │
│    - migrate.ts      (one-shot CSV → HubSpot)                    │
│    - server.ts       (long-running Airtable → HubSpot webhook)   │
│    - sync-cli.ts     (single-record sync from CLI)               │
│    - bootstrap_hubspot.ts (idempotent custom-property setup)     │
└─────┬─────────────────────────────────────────────────────┬──────┘
      │                                                     │
      ▼                                                     ▼
┌───────────────────────┐                     ┌───────────────────────┐
│ Coercion (clean.ts)   │                     │  Sync engine (sync.ts)│
│  - bool, date, amount │                     │   - upsert-or-update  │
│  - percent, phone     │                     │   - idempotency lock  │
│  - int, enum          │                     │   - recursive assoc   │
│  - error-on-unknown   │                     │   - in-flight cache   │
└───────────┬───────────┘                     └───────────┬───────────┘
            │                                             │
            └────────┬────────────────┬───────────────────┘
                     ▼                ▼
              ┌──────────────┐  ┌──────────────┐
              │  mappers.ts  │  │  schemas.ts  │
              │  row → props │  │  Zod + enums │
              └──────┬───────┘  └──────────────┘
                     │
                     ▼
              ┌─────────────────────────┐
              │  hubspot.ts (axios)     │
              │   - batch endpoints     │
              │   - v4 associations     │
              │   - 429 retry / backoff │
              └──────────┬──────────────┘
                         ▼
                     HubSpot API
```

## Data flow — Part 1 (migration)

1. `loadCsv` reads all three CSVs into arrays of `Record<string, string>`.
2. `CompanyRowSchema.parse` / `ContactRowSchema.parse` / `DealRowSchema.parse` shape-check every row.
3. `mapCompany` / `mapContact` / `mapDeal` run every field through the coercer (`clean.ts`) and collect per-field `CoercionError`s into an `issues[]` array. A single bad field doesn't kill the row — the field is dropped, the row keeps going, and the audit records what happened.
4. `HubspotClient.findByExternalIdBatch` fetches existing records in one call per 100 external ids.
5. Records split into `{create, update}` lists; both go through the batch endpoints (`POST .../batch/create`, `POST .../batch/update`).
6. `HubspotClient.batchAssociate` creates every association in one call per 100 pairs, using `associationCategory: HUBSPOT_DEFINED` and the standard type ids (`279`, `341`, `3`).
7. Final audit JSON is written to `migration_data/audit-<timestamp>.json`.

## Data flow — Part 2 (middleware)

1. Airtable Automation fires `POST /webhook/airtable?token=<secret>` with `{ tableName, recordId }`.
2. Server verifies the shared secret in constant time, then returns `202` immediately.
3. `syncRecord` runs on the next tick:
   - Checks the in-flight cache to prevent double-processing concurrent webhooks.
   - Fetches the record from Airtable.
   - Maps to HubSpot properties via the shared coercers.
   - `hubspot_record_id` present → `PATCH .../objects/{type}/{id}`.
   - `hubspot_record_id` absent  → `POST .../objects/{type}` + write the new id back to Airtable.
4. For linked-record fields (`Company` on a Contact/Deal, `Deal` on a Line Item), `syncRecord` recurses to sync the referenced record first, then creates the association.

## Idempotency guarantees

Two-tier lock:

1. **`hubspot_record_id` in Airtable / `external_id` in HubSpot** — persistent, survives restarts. Presence = record exists; absence = record needs creating.
2. **`inFlight` Map in `sync.ts`** — in-memory, per-instance. Prevents overlapping webhooks for the same record from both hitting the "create" path in the window between HubSpot create and Airtable write-back.

If the middleware scales beyond one replica, promote (2) to Redis:

```ts
// pseudo
const lock = await redis.set(`sync:${table}:${recordId}`, "1", "NX", "EX", 60);
if (!lock) return; // another instance is handling this
```

## Failure modes and their handling

| Failure                          | What happens                                                     |
|----------------------------------|------------------------------------------------------------------|
| Coercion error on one field      | Field dropped, row proceeds, issue counted in audit              |
| Row schema fails Zod parse       | Migration throws, non-zero exit — the CSV shape is fundamentally wrong |
| HubSpot 429 rate limit           | axios interceptor waits `Retry-After` seconds and retries        |
| HubSpot 4xx (bad property)       | Batch fails, error logged, migration exits non-zero              |
| Orphan foreign key               | Record still upserted; the association step skips the missing edge |
| Airtable webhook without secret  | 401                                                              |
| Airtable webhook with unknown table | 400                                                          |
| HubSpot create succeeds, Airtable write-back fails | Next webhook creates a duplicate. Mitigation: retry the Airtable write with a 3× exponential backoff before giving up (implemented in `sync.ts`'s `upsert` via wrapping `airtable.update` in retryable code — TODO for a follow-up, not currently implemented) |

## Trade-offs I considered

**Batch vs single-record for Part 1.** Batch endpoints are ~50× cheaper on rate limits and 30× faster on wall clock. Downside is per-row error attribution — if one row in a batch of 100 fails, the batch API returns a partial-success response and you have to look at the `results` and `errors` arrays. For this scale (300–400 rows/entity) the tradeoff is worth it.

**External ID column vs email/domain matching.** The assessment CSVs have first-class `company_id`, `contact_id`, `deal_id`. Using these as `external_id` gives a stable, invariant key even if names/domains change. Email or domain-based matching would collide on shared inboxes and misattribute on renamed companies.

**In-line audit vs separate service.** For an assessment, a JSON file dropped next to the CSVs is enough. In production I'd stream coercion events to a log aggregator (Cloud Logging, Datadog) with structured fields so grafana panels can chart "coercion failures per hour per field."

**Webhook auth via query token vs HMAC.** Airtable's built-in "Send webhook" Automation action doesn't sign payloads. HMAC would require the Airtable Webhooks API (a heavier setup). For an assessment with a scoped shared secret, `?token=...` compared in constant time is enough. Not enough for a payment endpoint, but that's not what this is.
