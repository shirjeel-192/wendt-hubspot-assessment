import { loadEnv } from "../src/env.js";
import { HubspotClient } from "../src/hubspot.js";
import axios from "axios";

const env = loadEnv();
const token = env.HUBSPOT_ACCESS_TOKEN;

async function fetchSample(objectType: string, externalId: string, props: string[]) {
  const hs = new HubspotClient(token);
  const id = await hs.findByExternalId(objectType as "companies" | "contacts" | "deals", externalId);
  if (!id) return console.log(`[${objectType} ext=${externalId}] not found`);
  const res = await axios.get(`https://api.hubapi.com/crm/v3/objects/${objectType}/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { properties: props.join(",") },
  });
  console.log(`\n=== ${objectType} ext_id=${externalId} hubspot_id=${id} ===`);
  console.log(JSON.stringify(res.data.properties, null, 2));

  // Fetch associations
  const assocTypes = objectType === "companies" ? [] : objectType === "contacts" ? ["companies"] : ["companies", "contacts"];
  for (const to of assocTypes) {
    const a = await axios.get(
      `https://api.hubapi.com/crm/v4/objects/${objectType}/${id}/associations/${to}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`associations -> ${to}:`, a.data.results?.map((r: { toObjectId: number }) => r.toObjectId));
  }
}

await fetchSample("companies", "1", [
  "external_id", "name", "domain", "industry_source", "numberofemployees",
  "is_customer", "is_key_account", "account_manager", "created_date_custom", "renewal_date",
]);
await fetchSample("contacts", "1", [
  "external_id", "firstname", "lastname", "email", "phone", "lifecyclestage",
  "is_subscribed", "is_decision_maker", "lead_source", "preferred_contact_method",
]);
await fetchSample("deals", "1", [
  "external_id", "dealname", "amount", "dealstage", "closedate",
  "is_won", "deal_type", "region", "discount_percentage",
]);
