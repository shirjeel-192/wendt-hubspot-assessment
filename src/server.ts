/**
 * Fastify server for the Airtable -> HubSpot middleware.
 *
 * Endpoints:
 *   POST /webhook/airtable   Airtable Automation posts here on record create/update.
 *   POST /sync/:table/:id    Manual trigger for a single record (backfill or debugging).
 *   GET  /healthz            Liveness/readiness probe for Cloud Run.
 *
 * Authentication:
 *   Airtable's built-in Automation "Send webhook" action does NOT sign the
 *   payload with HMAC. We use a shared secret in the URL query string
 *   (?token=...) and constant-time-compare it against AIRTABLE_WEBHOOK_SECRET.
 *   If you want HMAC signing, use the Airtable Webhooks API instead (see
 *   docs/ARCHITECTURE.md for the tradeoff).
 *
 * Webhook payload shape (defined by the Automation action):
 *   { "tableName": "Companies", "recordId": "recXXXXXXXXXXXX" }
 *
 * The Airtable Automation is configured under scripts/setup_airtable.md.
 */

import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";

import { loadEnv } from "./env.js";
import { logger } from "./logger.js";
import { AirtableClient, AirtableTable } from "./airtable.js";
import { HubspotClient } from "./hubspot.js";
import { syncRecord, SyncContext } from "./sync.js";

const TABLE_WHITELIST: AirtableTable[] = ["Companies", "Contacts", "Deals", "Line Items"];

async function build() {
  const env = loadEnv({ requireAirtable: true });
  const airtable = new AirtableClient(env.AIRTABLE_API_KEY!, env.AIRTABLE_BASE_ID!);
  const hubspot = new HubspotClient(env.HUBSPOT_ACCESS_TOKEN);
  const ctx: SyncContext = { airtable, hubspot };

  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/webhook/airtable", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = (req.query as { token?: string }).token ?? "";
    if (!env.AIRTABLE_WEBHOOK_SECRET || !constantEq(token, env.AIRTABLE_WEBHOOK_SECRET)) {
      logger.warn({ ip: req.ip }, "webhook auth failed");
      return reply.code(401).send({ error: "unauthorized" });
    }

    const body = req.body as { tableName?: string; recordId?: string } | undefined;
    if (!body?.tableName || !body?.recordId) {
      return reply.code(400).send({ error: "tableName and recordId are required" });
    }
    if (!TABLE_WHITELIST.includes(body.tableName as AirtableTable)) {
      return reply.code(400).send({ error: `unknown table ${body.tableName}` });
    }

    // Fire-and-return so Airtable doesn't retry on slow HubSpot calls.
    // The syncRecord in-flight cache guarantees we don't double-create if
    // the same record change fires two webhooks in flight.
    setImmediate(() => {
      syncRecord(ctx, body.tableName as AirtableTable, body.recordId!).catch((err) => {
        logger.error(
          { err: err?.message, table: body.tableName, recordId: body.recordId, resp: err?.response?.data },
          "sync failed"
        );
      });
    });
    return reply.code(202).send({ status: "accepted" });
  });

  app.post("/sync/:table/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const p = req.params as { table: string; id: string };
    if (!TABLE_WHITELIST.includes(p.table as AirtableTable)) {
      return reply.code(400).send({ error: `unknown table ${p.table}` });
    }
    // Manual endpoint runs synchronously so the caller sees any errors.
    try {
      const hubspotId = await syncRecord(ctx, p.table as AirtableTable, p.id);
      return reply.send({ hubspotId });
    } catch (err) {
      const e = err as Error & { response?: { data?: unknown } };
      logger.error({ err: e?.message, resp: e?.response?.data }, "manual sync failed");
      return reply.code(500).send({ error: e?.message ?? "unknown error" });
    }
  });

  return { app, env };
}

function constantEq(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

async function main() {
  const { app, env } = await build();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info({ port: env.PORT }, "middleware listening");
}

main().catch((err) => {
  logger.error({ err: err?.message }, "server failed to start");
  process.exit(1);
});
