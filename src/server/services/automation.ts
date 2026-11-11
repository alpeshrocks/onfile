import { and, eq, inArray } from "drizzle-orm";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { appendEvent } from "../audit";
import { now } from "../clock";
import type { Ctx } from "../context";
import { getDb } from "../db";
import { envelopes, files, signers, workspaces } from "../db/schema";
import { emitWebhook } from "../webhooks";
import { filePayload, remindAgreement } from "./files";

/**
 * The follow-up nobody should have to remember: send due reminders and expire stale
 * requests. Called by a daily cron (and by the "Run now" button). It is idempotent:
 * a reminder is due only when reminderCount says the next one has not gone out, so running
 * it twice in a day sends nothing twice.
 */
export async function runAutomation(baseUrl: string, onlyWorkspaceId?: string) {
  const at = now();
  const db = await getDb();
  const where = [inArray(envelopes.status, ["sent", "partially_signed"])];
  if (onlyWorkspaceId) where.push(eq(envelopes.workspaceId, onlyWorkspaceId));
  const open = await db
    .select({ envelope: envelopes, workspace: workspaces })
    .from(envelopes)
    .innerJoin(workspaces, eq(workspaces.id, envelopes.workspaceId))
    .where(and(...where));

  let reminded = 0;
  let expired = 0;
  const errors: string[] = [];

  for (const { envelope, workspace } of open) {
    const settings = { ...DEFAULT_SETTINGS, ...workspace.settings };
    const ctx: Ctx = { workspaceId: workspace.id, actor: { kind: "system", name: "Onfile reminders" }, baseUrl };
    try {
      if (envelope.expiresAt && envelope.expiresAt <= at) {
        const result = await db.transaction(async (tx) => {
          const [locked] = await tx.select().from(envelopes).where(eq(envelopes.id, envelope.id)).for("update");
          if (locked.status !== "sent" && locked.status !== "partially_signed") return null;
          await tx.update(envelopes).set({ status: "expired" }).where(eq(envelopes.id, envelope.id));
          await tx.update(files).set({ status: "expired", updatedAt: at }).where(eq(files.id, envelope.fileId));
          await appendEvent(tx, {
            workspaceId: workspace.id,
            envelopeId: envelope.id,
            fileId: envelope.fileId,
            type: "agreement.expired",
            actor: ctx.actor,
            at,
          });
          const [file] = await tx.select().from(files).where(eq(files.id, envelope.fileId));
          const people = await tx.select().from(signers).where(eq(signers.envelopeId, envelope.id));
          return { file, people };
        });
        if (result) {
          expired++;
          await emitWebhook(db, workspace.id, "agreement.expired", filePayload(result.file, { ...envelope, status: "expired" }, result.people, baseUrl));
        }
        continue;
      }

      const dueDay = settings.reminderDays[envelope.reminderCount];
      if (dueDay !== undefined && at.getTime() >= envelope.sentAt.getTime() + dueDay * 86_400_000) {
        const r = await remindAgreement(ctx, envelope.id, { automatic: true });
        if (r.reminded > 0) reminded++;
      }
    } catch (err) {
      errors.push(`${envelope.id}: ${err instanceof Error ? err.message : "failed"}`);
    }
  }
  return { checked: open.length, reminded, expired, errors };
}
