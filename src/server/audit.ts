import { asc, desc, eq, sql } from "drizzle-orm";
import { now } from "./clock";
import type { Actor } from "@/lib/types";
import { canonicalJson, newId, sha256Hex } from "./crypto";
import type { Tx } from "./db";
import { envelopes, events, type EventRow } from "./db/schema";

/**
 * Tamper-evident audit trail.
 *
 * Each event stores the hash of the previous event for the same agreement, so the trail is
 * a chain: editing or deleting any row breaks every hash after it. verifyChain() recomputes
 * the chain and is run when a certificate is produced and on the public verification page.
 */

const GENESIS = "0".repeat(64);

interface EventInput {
  workspaceId: string;
  envelopeId: string;
  fileId: string;
  type: string;
  actor: Actor;
  ip?: string | null;
  userAgent?: string | null;
  data?: Record<string, unknown>;
  at?: Date;
}

function digest(e: {
  envelopeId: string;
  seq: number;
  type: string;
  actor: Actor;
  ip: string | null;
  userAgent: string | null;
  data: Record<string, unknown>;
  createdAt: Date;
  prevHash: string;
}) {
  return sha256Hex(
    canonicalJson({
      envelopeId: e.envelopeId,
      seq: e.seq,
      type: e.type,
      actor: e.actor,
      ip: e.ip,
      userAgent: e.userAgent,
      data: e.data,
      at: e.createdAt.toISOString(),
      prev: e.prevHash,
    }),
  );
}

/**
 * Append an event. Must run inside a transaction: it locks the envelope row so two
 * concurrent writers cannot both claim the same sequence number.
 */
export async function appendEvent(tx: Tx, input: EventInput): Promise<EventRow> {
  await tx.execute(sql`SELECT id FROM ${envelopes} WHERE ${envelopes.id} = ${input.envelopeId} FOR UPDATE`);
  const [last] = await tx
    .select({ seq: events.seq, hash: events.hash })
    .from(events)
    .where(eq(events.envelopeId, input.envelopeId))
    .orderBy(desc(events.seq))
    .limit(1);

  const row = {
    id: newId("evt"),
    workspaceId: input.workspaceId,
    envelopeId: input.envelopeId,
    fileId: input.fileId,
    seq: (last?.seq ?? 0) + 1,
    type: input.type,
    actor: input.actor,
    ip: input.ip ?? null,
    userAgent: input.userAgent ? input.userAgent.slice(0, 300) : null,
    data: input.data ?? {},
    // Millisecond precision so the stored value round-trips exactly through Postgres.
    createdAt: new Date(Math.floor((input.at ?? now()).getTime())),
    prevHash: last?.hash ?? GENESIS,
    hash: "",
  };
  row.hash = digest(row);
  await tx.insert(events).values(row);
  return row as EventRow;
}

export function verifyChain(rows: EventRow[]): { ok: boolean; brokenAt?: number } {
  let prev = GENESIS;
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (e.seq !== i + 1 || e.prevHash !== prev || digest(e) !== e.hash) return { ok: false, brokenAt: e.seq };
    prev = e.hash;
  }
  return { ok: true };
}

export async function envelopeEvents(db: Pick<Tx, "select">, envelopeId: string) {
  return db.select().from(events).where(eq(events.envelopeId, envelopeId)).orderBy(asc(events.seq));
}
