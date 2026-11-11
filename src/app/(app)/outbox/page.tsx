import { desc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { OutboxView } from "@/components/outbox-view";
import { PageHeader } from "@/components/ui";
import { requireCtx } from "@/server/auth";
import { getDb } from "@/server/db";
import { emails } from "@/server/db/schema";
import { emailConfigured } from "@/server/email";

export const metadata: Metadata = { title: "Outbox" };

export default async function OutboxPage() {
  const { ctx } = await requireCtx();
  const db = await getDb();
  const rows = await db.select().from(emails).where(eq(emails.workspaceId, ctx.workspaceId)).orderBy(desc(emails.createdAt)).limit(100);
  return (
    <>
      <PageHeader title="Outbox" description="Every email Onfile has sent on your behalf, exactly as the recipient sees it." />
      <p className="mb-5 rounded-xl border border-line bg-surface p-4 text-sm text-ink-2">
        {emailConfigured() ? (
          <>
            <strong className="font-semibold text-ink">Email delivery is on.</strong> Messages go out through Resend and are also kept here.
          </>
        ) : (
          <>
            <strong className="font-semibold text-ink">Email delivery is not connected on this deployment.</strong> Messages are held here instead of being sent, so nothing is lost: open a
            file to copy its signing link or show its QR code. Add a RESEND_API_KEY to send for real.
          </>
        )}
      </p>
      <OutboxView emails={rows.map((e) => ({ id: e.id, kind: e.kind, toEmail: e.toEmail, toName: e.toName, subject: e.subject, html: e.html, status: e.status, error: e.error, createdAt: e.createdAt.toISOString() }))} />
    </>
  );
}
