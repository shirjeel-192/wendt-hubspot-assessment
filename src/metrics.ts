/**
 * Simple in-memory metrics collector for the migration run.
 * Prints a summary at the end and writes the counts to migration_data/audit.json
 * so a follow-up analysis can trace exactly which coercions fired and how often.
 */

type Counter = Map<string, number>;

class MetricsRegistry {
  private counters = new Map<string, Counter>();
  private issues: { kind: string; row: unknown; message: string }[] = [];

  inc(bucket: string, label: string, by: number = 1): void {
    let counter = this.counters.get(bucket);
    if (!counter) {
      counter = new Map<string, number>();
      this.counters.set(bucket, counter);
    }
    counter.set(label, (counter.get(label) ?? 0) + by);
  }

  issue(kind: string, row: unknown, message: string): void {
    this.issues.push({ kind, row, message });
    this.inc("issues", kind);
  }

  snapshot() {
    const out: Record<string, Record<string, number>> = {};
    for (const [bucket, counter] of this.counters.entries()) {
      out[bucket] = Object.fromEntries(counter.entries());
    }
    return { counters: out, issues: this.issues };
  }

  reset(): void {
    this.counters.clear();
    this.issues = [];
  }
}

export const metrics = new MetricsRegistry();
