# Wendt Partners HubSpot Technical Assessment

Two-part deliverable:

- **Part 1** — CSV → HubSpot migration for Companies, Contacts, Deals, preserving all associations.
- **Part 2** — Airtable ↔ HubSpot middleware that syncs record changes in near-real-time, idempotently.

Everything runs from a single Node.js 20 + TypeScript codebase. Both parts share the coercion layer, the HubSpot API client, and the field mappers.

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy the env template and fill in tokens
cp .env.example .env
# ... edit .env with your HubSpot dev sandbox token, Airtable API key, base id, and webhook secret

# 3. Run all tests
npm test

# 4. Dry-run the migration against the CSVs (no HubSpot calls, just prints mapped payloads)
npm run migrate:dry

# 5. Bootstrap the HubSpot custom properties (idempotent, safe to re-run)
npm run bootstrap:hubspot

# 6. Run the actual migration
npm run migrate

# 7. Start the Airtable middleware locally
npm run server
# → listens on :8080; POST /webhook/airtable?token=<secret>

# 8. Deploy the middleware to Cloud Run (needs `gcloud` logged in)
./scripts/deploy.sh <project-id> <region>
```

Test results and dry-run coerce all **1,100 rows** (300 companies + 400 contacts + 400 deals) with **zero coercion failures**. The only remaining issues in the data are 5 orphan contacts + 2 orphan deals whose `company_id` doesn't exist in `companies.csv` — real referential-integrity bugs in the source, flagged in the audit and skipped for the association step but still upserted as bare records.

---

## Part 1 — CSV migration

### What it does

1. Loads all three CSVs and validates their shape with Zod.
2. Runs a pre-flight referential-integrity check (orphan foreign keys).
3. Maps every row through the coercion layer:
   - Boolean coercion for `is_customer`, `is_key_account`, `is_subscribed`, `is_decision_maker`, `is_won` (accepts `1/0/True/False/Yes/No`).
   - Date coercion for `created_date`, `renewal_date`, `close_date` (handles `YYYY-MM-DD`, `YYYY/MM/DD`, `MM/DD/YYYY`, `MM-DD-YYYY`, `DD/MM/YYYY`, `MM/YYYY`).
   - Amount coercion for `amount` (strips `$` and commas, tolerates raw floats and ints).
   - Percent coercion for `discount_percentage` (strips trailing `%`).
   - Phone coercion for `phone` (normalises `5550422`, `555-0245`, `555.0611`, `+1-555-0278`, `(555) 0141` all to `+15555550XXX`).
   - Enum coercion for `lifecycle_stage`, `preferred_contact_method`, `lead_source`, `deal_type`, `region`, `deal_stage` (case-insensitive whitelist match).
4. **Upserts** to HubSpot via batch endpoints, using a custom `external_id` property for idempotency. Re-running the script is safe — existing records get updated, new records get created.
5. Creates the three association types in bulk:
   - `contact → company` (HubSpot type 279)
   - `deal → company`   (HubSpot type 341)
   - `deal → contact`   (HubSpot type 3)
6. Writes an audit JSON (`migration_data/audit-<timestamp>.json`) with per-field coercion counts, orphan lists, and rows-with-issues counts.

### Ordering matters

Companies → Contacts → Deals. Contacts depend on companies for the `contact → company` association; deals depend on both. The migration script enforces this ordering internally.

### Custom properties

Standard HubSpot properties (`name`, `domain`, `industry`, `firstname`, `lastname`, `email`, `phone`, `lifecyclestage`, `dealname`, `amount`, `dealstage`, `closedate`, `numberofemployees`) are pre-existing.

`scripts/bootstrap_hubspot.ts` creates the source-specific custom properties:

- Companies: `external_id`, `is_customer`, `is_key_account`, `account_manager`, `created_date_custom`, `renewal_date`
- Contacts: `external_id`, `is_subscribed`, `is_decision_maker`, `lead_source`, `preferred_contact_method`
- Deals: `external_id`, `is_won`, `deal_type`, `region`, `discount_percentage`

All idempotent — `GET` first, `POST` only if 404.

---

## Part 2 — Airtable ↔ HubSpot middleware

### What it does

- Listens on `POST /webhook/airtable?token=<secret>` for change events fired by Airtable Automations.
- Reads the changed record from Airtable, maps it to HubSpot properties, and either creates (if `hubspot_record_id` is blank) or updates (if it's set) the HubSpot record.
- Writes the new HubSpot id back to the Airtable row's `hubspot_record_id` — this is the idempotency lock.
- Handles associations recursively: syncing a Deal will sync its linked Company first if that Company doesn't yet have a `hubspot_record_id`.
- Line Items are supported as a fourth table, associated to Deals via the `HUBSPOT_DEFINED` line-item association type.

### Idempotency contract

- `hubspot_record_id` presence = the record already exists in HubSpot.
- Absence = create it.
- Two overlapping webhooks for the same Airtable record hit the same in-flight promise cache and wait on the first completion — no double-creates.
- Airtable's built-in Automation retries are safe (the middleware returns 202 fast; actual work happens in `setImmediate`).

### Deal stage mapping (per Part 2 spec)

| Airtable Deal Stage | HubSpot dealstage      |
|---------------------|------------------------|
| Won                 | closedwon              |
| Lost                | closedlost             |
| Anything else       | qualifiedtobuy         |

Implemented in `src/mappers.ts::mapAirtableDealStage()` with case-insensitive comparison.

### Airtable base setup

See [scripts/setup_airtable.md](scripts/setup_airtable.md). Every field name and Automation configuration is documented there.

### Deployment

`./scripts/deploy.sh <project-id> <region>` builds the container, pushes to Artifact Registry, and deploys to Cloud Run. Secrets are pulled from Secret Manager at runtime — never baked into the image.

Alternative platforms this would drop into: AWS Lambda (Function URL + Secrets Manager), Azure Container Apps, or Fly.io. Fastify boots in ~150 ms so cold-start is fine on any of them.

---

## Architecture

```
CSVs                        Airtable
  │                              │
  │ (one-shot)                   │ (Automation trigger)
  │                              │
  ▼                              ▼
migrate.ts                   server.ts
  │                              │
  │  mapCompany/Contact/Deal     │  syncRecord
  │      ├── clean.ts ──────────►│
  │      └── mappers.ts          │
  │                              │
  ▼                              ▼
       ┌────── hubspot.ts ──────┐
       │    axios + rate-limit  │
       │    batch endpoints     │
       │    v4 associations     │
       └────────┬───────────────┘
                │
                ▼
             HubSpot
```

Shared modules:

| Module                | Responsibility                                                      |
|-----------------------|---------------------------------------------------------------------|
| `src/clean.ts`        | Every coercion function. Pure, no I/O, individually testable.       |
| `src/schemas.ts`      | Zod row schemas + enum whitelists + custom property name constant.  |
| `src/mappers.ts`      | Row → HubSpot property object. Wraps coercers, collects issues.     |
| `src/hubspot.ts`      | axios wrapper: batch CRUD, associations, custom-property bootstrap. |
| `src/airtable.ts`     | Airtable client + `AIRTABLE_FIELDS` constant.                       |
| `src/sync.ts`         | One-record sync engine (Part 2). Handles idempotency lock.          |
| `src/migrate.ts`      | Part 1 entry point.                                                 |
| `src/server.ts`       | Part 2 entry point.                                                 |
| `src/metrics.ts`      | In-memory counters + issues list for the audit JSON.                |
| `src/env.ts`          | Env var loading with Zod validation.                                |
| `src/logger.ts`       | pino, pretty-print in TTY, JSON in prod.                            |

### Why TypeScript over Python

The assessment mentions both Node.js and Python. TypeScript because:

1. The middleware is a webhook server — Node's event loop + `setImmediate` fits perfectly.
2. Same language for both parts means one dependency tree, one test runner, one CI pipeline.
3. Zod gives runtime + compile-time schema validation with the same declarations, so the mappers can't drift from the source shapes without the type system flagging it.

### Non-obvious decisions

- **Amount is a plain number in the mapped payload.** HubSpot's API accepts both `"48469"` and `48469` for currency properties. Sending a number is cleaner and avoids locale-formatting bugs.
- **`created_date_custom` instead of `createdate`.** HubSpot's built-in `createdate` is read-only. The source system's record-creation date lives in a new custom property so we don't lose it.
- **In-memory idempotency cache.** Fine for a single-instance middleware. If the middleware scales to N replicas, promote the in-flight map to Redis or Cloud Firestore — swap out `sync.ts`'s `inFlight` Map for a Redis SETNX with 60 s expiry.
- **No `--no-verify` git commits, no fake-token fallbacks.** Missing env vars fail fast at startup.

---

## Testing

```bash
npm test           # 51 tests covering every coercion + the deal-stage mapper
npm run migrate:dry  # end-to-end pipeline dry-run against the real CSVs
```

The dry-run is the closest thing to an integration test without a live sandbox — it exercises loader → validator → mapper → association-graph exactly as production would, and asserts that all 1,100 rows produce a mapped payload with zero coercion failures.

---

## Known limitations

- **DD/MM vs MM/DD ambiguity.** When both components are ≤ 12 (e.g. `04/06/2024`), we default to US MM/DD. See [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) for the full rationale.
- **Two-way sync.** The middleware syncs Airtable → HubSpot only. Reverse direction is a straight extension: subscribe to HubSpot webhooks (`contact.propertyChange`, `deal.propertyChange`, etc.) and reuse the mapper + client.
- **Line-item association type id.** HubSpot's documented `HUBSPOT_DEFINED` deal-to-line-item type id is `20`; verified on the current v4 API but subject to change. If HubSpot rev's this, look up via `GET /crm/v4/associations/line_items/deals/labels`.
- **Transitive dep vulnerabilities.** `npm audit` flags a `find-my-way` HTTP/2 DDoS issue via Fastify 4. Not exploitable behind Cloud Run's HTTP/1 termination; fix path is Fastify 5 (breaking change deferred).

---

## Repo layout

```
wendt-hubspot-assessment/
├── README.md                 (this file)
├── package.json
├── tsconfig.json
├── .env.example
├── Dockerfile
├── migration_data/           # CSVs provided by the assessment
│   ├── companies.csv
│   ├── contacts.csv
│   └── deals.csv
├── src/
│   ├── clean.ts              # coercion functions (pure)
│   ├── schemas.ts            # Zod row schemas + enum whitelists
│   ├── mappers.ts            # row → HubSpot property object
│   ├── hubspot.ts            # HubSpot API client
│   ├── airtable.ts           # Airtable client
│   ├── sync.ts               # single-record sync engine (Part 2)
│   ├── migrate.ts            # Part 1 entry point
│   ├── server.ts             # Part 2 entry point (Fastify)
│   ├── sync-cli.ts           # CLI wrapper around sync engine
│   ├── env.ts
│   ├── logger.ts
│   ├── metrics.ts
│   └── csvLoader.ts
├── scripts/
│   ├── bootstrap_hubspot.ts  # create HubSpot custom properties
│   ├── setup_airtable.md     # Airtable base setup guide (manual UI steps)
│   └── deploy.sh             # Cloud Run deploy script
├── tests/
│   ├── clean.test.ts         # 51 unit tests
│   └── inspect-dates.ts      # ad-hoc data-mess exploration tool
└── docs/
    ├── ARCHITECTURE.md
    └── ASSUMPTIONS.md
```
