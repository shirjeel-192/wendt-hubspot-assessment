import { coerceDate, CoercionError } from "../src/clean.js";
import { loadCsv } from "../src/csvLoader.js";

const companies = loadCsv<Record<string, string>>("migration_data/companies.csv");
const deals = loadCsv<Record<string, string>>("migration_data/deals.csv");

function check(label: string, rows: Record<string, string>[], field: string) {
  const failing: { raw: string; err: string }[] = [];
  for (const r of rows) {
    try { coerceDate(field, r[field]); }
    catch (e) { if (e instanceof CoercionError) failing.push({ raw: String(r[field]), err: e.message }); }
  }
  console.log(`\n${label} → ${failing.length} failures`);
  failing.slice(0, 15).forEach((f) => console.log(`  '${f.raw}': ${f.err}`));
}

check("companies.created_date", companies, "created_date");
check("companies.renewal_date", companies, "renewal_date");
check("deals.close_date", deals, "close_date");
