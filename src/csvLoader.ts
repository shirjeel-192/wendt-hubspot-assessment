import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";

/**
 * Loads a CSV file and returns an array of objects keyed by header names.
 * Uses the sync parser because these files are 300-400 rows each and
 * streaming buys us nothing at this size.
 *
 * Options mirror csv-parse defaults except:
 *   - columns: true         → return objects, not arrays
 *   - skip_empty_lines      → trailing newlines don't produce empty rows
 *   - trim: false           → we deliberately do NOT trim here; the coercers
 *                             own that so we can spot leading/trailing space
 *                             issues in the audit if we care about them.
 *   - relax_column_count    → tolerate rows with extra/missing columns
 */
export function loadCsv<T = Record<string, string>>(path: string): T[] {
  const text = readFileSync(path, "utf-8");
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: false,
  }) as T[];
  return rows;
}
