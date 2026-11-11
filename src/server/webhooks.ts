import { and, eq, sql } from "drizzle-orm";
import { decrypt, hmacHex, newId } from "./crypto";
import type { DbOrTx } from "./db";
import { rateLimits, webhookDeliveries, webhooks } from "./db/schema";

export const WEBHOOK_EVENTS = [
  "agreement.sent",
  "agreement.viewed",
  "agreement.signed",
  "agreement.completed",
  "agreement.declined",
  "agreement.voided",
  "agreement.expired",
] as const;

/** Refuse obviously internal targets so a webhook cannot be aimed at the host's own network. */
export function isSafeWebhookUrl(raw: string) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    if (process.env.NODE_ENV === "production") {
      if (url.protocol !== "https:") return false;
      if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
      if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === "[::1]") return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Deliver one event to every active endpoint of a workspace.
 * The body is signed: X-Onfile-Signature: t=<unix>,v1=<hmac_sha256(secret, t + "." + body)>
 */
export async function emitWebhook(db: DbOrTx, workspaceId: string, type: string, data: Record<string, unknown>) {
  const hooks = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.workspaceId, workspaceId), eq(webhooks.active, true)));
  if (!hooks.length) return;

  const payload = { id: newId("whe"), type, created_at: new Date().toISOString(), data };
  const body = JSON.stringify(payload);
  await Promise.all(
    hooks.map(async (hook) => {
      const started = Date.now();
      let statusCode: number | null = null;
      let ok = false;
      let error: string | null = null;
      try {
        if (!isSafeWebhookUrl(hook.url)) throw new Error("Endpoint URL is not allowed");
        const t = Math.floor(Date.now() / 1000);
        const res = await fetch(hook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Onfile-Webhooks/1.0",
            "X-Onfile-Event": type,
            "X-Onfile-Signature": `t=${t},v1=${hmacHex(decrypt(hook.secretEnc), `${t}.${body}`)}`,
          },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(8_000),
        });
        statusCode = res.status;
        ok = res.ok;
        if (!ok) error = `Endpoint responded ${res.status}`;
      } catch (err) {
        error = err instanceof Error ? err.message : "Request failed";
      }
      await db.insert(webhookDeliveries).values({
        id: newId("whd"),
        workspaceId,
        webhookId: hook.id,
        eventType: type,
        payload,
        statusCode,
        ok,
        error,
        durationMs: Date.now() - started,
      });
    }),
  );
}

/**
 * Fixed-window rate limit backed by Postgres, so it holds across serverless instances.
 * Returns true when the caller is within the limit.
 */
export async function rateLimit(db: DbOrTx, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`CASE WHEN ${rateLimits.windowStart} = ${windowStart} THEN ${rateLimits.count} + 1 ELSE 1 END`,
        windowStart,
      },
    })
    .returning({ count: rateLimits.count });
  return (row?.count ?? 1) <= limit;
}
