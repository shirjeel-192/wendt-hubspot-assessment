# Airtable base setup

Airtable's API can create records inside a base, but the base itself and
its table/column definitions have to be created via the UI. Follow the
steps below to build a base that matches what `src/sync.ts` expects.

## 1. Create the base

1. Sign in at https://airtable.com and create a new base named
   `Wendt HubSpot Sync`.
2. Delete the default Table 1.

## 2. Create four tables with the fields below

Field names must match exactly — they're referenced in
`src/airtable.ts` (`AIRTABLE_FIELDS`).

### Companies

| Field                | Type                        | Notes                                    |
|----------------------|-----------------------------|------------------------------------------|
| Company Name         | Single line text            | Primary                                  |
| Domain               | URL                         |                                          |
| Industry             | Single line text            |                                          |
| hubspot_record_id    | Single line text            | Leave blank; middleware writes here      |
| Contacts             | Link to Contacts (auto)     | Reverse-created when you add the field   |
| Deals                | Link to Deals (auto)        | Reverse-created when you add the field   |

### Contacts

| Field                | Type                        | Notes                                    |
|----------------------|-----------------------------|------------------------------------------|
| First Name           | Single line text            |                                          |
| Last Name            | Single line text            |                                          |
| Email                | Email                       | Primary                                  |
| Phone                | Phone number                |                                          |
| Company              | Link to Companies           |                                          |
| hubspot_record_id    | Single line text            | Leave blank                              |

### Deals

| Field                | Type                        | Notes                                    |
|----------------------|-----------------------------|------------------------------------------|
| Deal Name            | Single line text            | Primary                                  |
| Amount               | Currency (USD)              |                                          |
| Deal Stage           | Single select               | Options: Won, Lost, Negotiation, Pending |
| Close Date           | Date                        | ISO format                               |
| Company              | Link to Companies           |                                          |
| Line Items           | Link to Line Items (auto)   |                                          |
| hubspot_record_id    | Single line text            | Leave blank                              |

### Line Items

| Field                | Type                        | Notes                                    |
|----------------------|-----------------------------|------------------------------------------|
| Product Name         | Single line text            | Primary                                  |
| Quantity             | Number (integer)            |                                          |
| Unit Price           | Currency (USD)              |                                          |
| Deal                 | Link to Deals               |                                          |
| hubspot_record_id    | Single line text            | Leave blank                              |

## 3. Create the sync automations

For each table, create an Automation with:

- **Trigger:** *When a record matches conditions* (leave conditions empty
  so it fires on any create/update — Airtable also has a straight
  "record created or updated" trigger; either works).
- **Action:** *Send a webhook*
  - Method: `POST`
  - URL: `https://<your-cloud-run-url>/webhook/airtable?token=<AIRTABLE_WEBHOOK_SECRET>`
  - Content type: `application/json`
  - Body:
    ```json
    {
      "tableName": "Companies",
      "recordId": "{{trigger.record.id}}"
    }
    ```
    Change `"Companies"` to the actual table name for the automation you're setting up.

## 4. Grab the base id

Base id looks like `appXXXXXXXXXXXX`. Find it at
https://airtable.com/api → open the base → the URL shows `/v0/<baseId>/`.

Set this as `AIRTABLE_BASE_ID` in `.env`.

## 5. Create a personal access token

https://airtable.com/create/tokens with scopes:

- `data.records:read`
- `data.records:write`
- `schema.bases:read`

Grant it access to the `Wendt HubSpot Sync` base. Set as `AIRTABLE_API_KEY`
in `.env`.

## 6. Set the shared secret

Pick any long random string and set it as `AIRTABLE_WEBHOOK_SECRET` in
`.env`. Paste the same string into every Automation webhook URL after
`?token=`.

## 7. Test

Create a Company in Airtable. Within a few seconds:

1. The middleware receives the webhook and logs `sync start`.
2. HubSpot receives a `POST /crm/v3/objects/companies` call.
3. Airtable receives an `hubspot_record_id` write with the new HubSpot id.
4. The record now shows the HubSpot id in Airtable, so any future edits
   fire an update instead of a create.
