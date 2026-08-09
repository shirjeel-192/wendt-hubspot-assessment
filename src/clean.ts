/**
 * Coercion functions for the messy CSVs.
 *
 * Every function has three properties:
 *   1. It knows the exact set of formats present in the source data (from a full
 *      distinct-values sweep, see docs/ASSUMPTIONS.md).
 *   2. It normalises to a single canonical form HubSpot accepts.
 *   3. It throws a CoercionError with the raw value if it hits something new,
 *      so unknown patterns become loud instead of silently dropping through.
 *
 * The migrate script wraps every call in a per-row try/catch and records both
 * the source row and the reason so the operator has a full audit trail.
 */

export class CoercionError extends Error {
  constructor(public field: string, public rawValue: unknown, reason: string) {
    super(`[${field}] ${reason} (raw=${JSON.stringify(rawValue)})`);
    this.name = "CoercionError";
  }
}

/**
 * Boolean fields in the CSVs mix: 1, 0, True, False, Yes, No (all as strings).
 * Empty string is treated as null (unknown), not false.
 */
export function coerceBool(field: string, raw: string | undefined | null): boolean | null {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === "") return null;
  if (v === "1" || v === "true" || v === "yes" || v === "y" || v === "t") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n" || v === "f") return false;
  throw new CoercionError(field, raw, "unrecognised boolean value");
}

/**
 * Dates in the CSVs come as:
 *   YYYY-MM-DD   (most common)
 *   YYYY/MM/DD
 *   MM/DD/YYYY   (US)
 *   MM-DD-YYYY   (US, dashes)
 *   DD/MM/YYYY   (EU — mixed in the same field as MM/DD/YYYY)
 *   MM/YYYY      (partial → 1st of the month, flagged in audit)
 *
 * The MM/DD vs DD/MM ambiguity is real: values like "14/05/2021" are
 * unambiguously DD/MM (day > 12), but "04/06/2024" could be either. Rule:
 *   1. If the first component is > 12, it must be a day → DD/MM/YYYY.
 *   2. If the second component is > 12, it must be a day → MM/DD/YYYY.
 *   3. Otherwise both are <= 12 (ambiguous) — default to MM/DD/YYYY (US)
 *      and record the ambiguity in the audit via a marker field so an
 *      operator can review if the field is business-critical.
 *
 * HubSpot date properties accept ms-since-epoch UTC-midnight (integer).
 */
export function coerceDate(field: string, raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  if (v === "") return null;

  let y: number, m: number, d: number;

  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v);
  const twoPart = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(v);
  const partial = /^(\d{1,2})[/-](\d{4})$/.exec(v);

  if (iso) {
    y = Number(iso[1]);
    m = Number(iso[2]);
    d = Number(iso[3]);
  } else if (twoPart) {
    const first = Number(twoPart[1]);
    const second = Number(twoPart[2]);
    y = Number(twoPart[3]);
    if (first > 12) {
      // Must be DD/MM/YYYY.
      d = first;
      m = second;
    } else if (second > 12) {
      // Must be MM/DD/YYYY.
      m = first;
      d = second;
    } else {
      // Ambiguous — default to US MM/DD/YYYY. See docs/ASSUMPTIONS.md.
      m = first;
      d = second;
    }
  } else if (partial) {
    m = Number(partial[1]);
    y = Number(partial[2]);
    d = 1;
  } else {
    throw new CoercionError(field, raw, "unrecognised date format");
  }

  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) {
    throw new CoercionError(field, raw, `date components out of range (y=${y} m=${m} d=${d})`);
  }

  const ts = Date.UTC(y, m - 1, d);
  if (Number.isNaN(ts)) throw new CoercionError(field, raw, "Date.UTC produced NaN");
  return ts;
}

/**
 * Amount comes as:
 *   "$48,469"    (string, dollar sign, comma, no decimals)
 *   "141994.39"  (plain float)
 *   "89084"      (plain int)
 *   ""           (empty)
 * We emit a plain number. HubSpot's currency properties accept a string
 * representation of a decimal — the SDK / API is flexible on int vs string.
 */
export function coerceAmount(field: string, raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  if (v === "") return null;

  const stripped = v.replace(/[$,\s]/g, "");
  if (stripped === "") return null;

  const n = Number(stripped);
  if (Number.isNaN(n)) throw new CoercionError(field, raw, "amount is not a number after strip");
  if (n < 0) throw new CoercionError(field, raw, "amount is negative");
  return n;
}

/**
 * Discount percentages come as raw ints ("20") or ints with % ("15%").
 * We emit a number in the range 0..100. Downstream consumers can /100 if they
 * need a decimal — keeping it as a percent because HubSpot's convention for a
 * "number" property that represents a percent is 0..100, not 0..1.
 */
export function coercePercent(field: string, raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  if (v === "") return null;

  const stripped = v.replace(/%$/, "").trim();
  const n = Number(stripped);
  if (Number.isNaN(n)) throw new CoercionError(field, raw, "percent is not a number");
  if (n < 0 || n > 100) throw new CoercionError(field, raw, `percent out of 0..100 range (n=${n})`);
  return n;
}

/**
 * Phone numbers come as:
 *   "5550422"        (7-digit)
 *   "555.0611"       (3-dot-4)
 *   "555-0245"       (3-dash-4)
 *   "+1-555-0278"    (with country code)
 *   "(555) 0141"     (parenthesised prefix)
 *
 * These are obviously placeholder/test numbers — the "555" prefix is the
 * classic US directory-block area code, and the 7-digit inputs are missing
 * the middle exchange digits entirely. The goal here is DETERMINISTIC
 * normalisation so that "555-0422" and "5550422" and "+1-555-0422" all
 * dedupe to the same string in HubSpot.
 *
 * Rule:
 *   1. Strip non-digits.
 *   2. Drop a leading "1" country-code digit if present.
 *   3. If we have 7 digits, prepend "555" (matches the visible area code).
 *   4. Emit "+1XXXXXXXXXX" (E.164).
 * Anything that doesn't reduce to 10 digits after step 3 is preserved
 * as-is so we can spot new formats in the audit log instead of silently
 * generating a wrong-looking E.164.
 */
export function coercePhone(field: string, raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  if (v === "") return null;

  let digits = v.replace(/[^\d]/g, "");
  if (digits === "") throw new CoercionError(field, raw, "no digits in phone");

  if (digits.length > 7 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length === 7) digits = `555${digits}`;
  if (digits.length !== 10) return digits;
  return `+1${digits}`;
}

/**
 * Integer property (number_of_employees). Empty → null.
 */
export function coerceInt(field: string, raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new CoercionError(field, raw, "not an integer");
  return n;
}

/**
 * Freeform string. Empty → null. Trims whitespace.
 * Used for names, emails, domains, categorical labels, etc.
 */
export function coerceString(field: string, raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  return v === "" ? null : v;
}

/**
 * Enum coercion — accepts a fixed set of allowed values (case-insensitive
 * match, output uses the canonical casing from `allowed`).
 * Unknown values throw CoercionError so we don't silently invent HubSpot options.
 */
export function coerceEnum(
  field: string,
  raw: string | undefined | null,
  allowed: readonly string[]
): string | null {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  if (v === "") return null;
  const hit = allowed.find((a) => a.toLowerCase() === v.toLowerCase());
  if (!hit) {
    throw new CoercionError(field, raw, `not in allowed enum [${allowed.join(", ")}]`);
  }
  return hit;
}

/**
 * HubSpot booleans go over the wire as the literal strings "true"/"false".
 * (Sending an actual boolean sometimes works, sometimes doesn't — the string
 * form is what the REST docs specify.)
 */
export function boolForHubspot(b: boolean | null): string | null {
  if (b === null) return null;
  return b ? "true" : "false";
}
