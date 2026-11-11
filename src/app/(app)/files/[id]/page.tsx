import { Time } from "@/components/time";
import { ArrowLeft, CircleCheck, Clock, Download, ExternalLink, FileText, Hourglass, MailWarning, ShieldCheck, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { EditSignerButton, RemindButton, ResendButton, VoidButton } from "@/components/file-actions";
import { buttonClass } from "@/components/button-class";
import { Badge, Card, CopyButton, StatusPill } from "@/components/ui";
import { EVENT_LABEL, formatDuration } from "@/lib/format";
import { and, desc, eq } from "drizzle-orm";
import { verifyChain } from "@/server/audit";
import { requireCtx } from "@/server/auth";
import { getDb } from "@/server/db";
import { emails } from "@/server/db/schema";
import { emailConfigured } from "@/server/email";
import { getFile } from "@/server/services/files";

export const metadata: Metadata = { title: "File" };

const SIGNER_STATUS = {
  pending: { label: "Not opened yet", tone: "neutral" },
  viewed: { label: "Opened, not signed", tone: "flag" },
  signed: { label: "Signed", tone: "green" },
  declined: { label: "Declined", tone: "red" },
} as const;

export default async function FilePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sent?: string }> }) {
  const { ctx } = await requireCtx();
  const { id } = await params;
  const justSent = (await searchParams).sent === "1";
  const detail = await getFile(ctx, id);
  if (!detail) notFound();
  const { file, envelopes, events } = detail;
  const current = envelopes[0] ?? null;
  const open = current && (current.status === "sent" || current.status === "partially_signed");
  const pending = current?.signers.filter((s) => s.status === "pending" || s.status === "viewed") ?? [];
  const qr = new Map<string, string>();
  if (open) for (const s of pending) qr.set(s.id, await QRCode.toString(s.url, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#0e1a2b", light: "#ffffff00" } }));
  const auditOk = current ? verifyChain(events.filter((e) => e.envelopeId === current.id)).ok : true;
  const decline = current?.signers.find((s) => s.status === "declined");
  // If the provider rejected a message, say so on the file: the link still works.
  const undelivered = open
    ? (
        await (await getDb())
          .select({ toEmail: emails.toEmail, error: emails.error })
          .from(emails)
          .where(and(eq(emails.envelopeId, current.id), eq(emails.status, "failed")))
          .orderBy(desc(emails.createdAt))
          .limit(1)
      )[0]
    : undefined;

  return (
    <>
      <Link href="/files" className="mb-5 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> Files
      </Link>

      {/* The file itself: a folder with its tab. */}
      <div>
        <span className="folder-tab">
          <span className="mono">{file.reference}</span>
        </span>
        <Card className="rounded-tl-none p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="display text-[30px] sm:text-[36px]">{file.clientName}</h1>
              <p className="mt-1.5 text-[15px] text-muted">
                {file.title ? `${file.title}. ` : ""}
                {file.clientEmail}
              </p>
            </div>
            <StatusPill status={file.status} className="h-7 px-3 text-[13px]" />
          </div>

          <div className="mt-6">
            {file.status === "signed" && current && (
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-green-50 p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <CircleCheck className="mt-0.5 size-6 shrink-0 text-green" />
                  <div>
                    <p className="text-[17px] font-semibold text-ink">Cleared to start</p>
                    <p className="text-sm text-ink-2">
                      Signed <Time value={current.completedAt} />
                      {current.completedAt ? `, ${formatDuration(current.completedAt.getTime() - current.sentAt.getTime())} after it was sent.` : "."}
                    </p>
                  </div>
                </div>
                <a href={`/api/documents/signed/${current.id}?download`} className={buttonClass("primary")}>
                  <Download className="size-4" /> Download signed agreement
                </a>
              </div>
            )}
            {file.status === "awaiting_signature" && current && (
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-flag-50 p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <Hourglass className="mt-0.5 size-6 shrink-0 text-flag-ink" />
                  <div>
                    <p className="text-[17px] font-semibold text-ink">On hold until the agreement is signed</p>
                    <p className="text-sm text-ink-2">
                      Sent <Time value={current.sentAt} mode="ago" />.{" "}
                      {current.reminderCount > 0 ? `${current.reminderCount} ${current.reminderCount === 1 ? "reminder" : "reminders"} sent. ` : "Reminders go out automatically. "}
                      {current.expiresAt && (
                        <>
                          Expires <Time value={current.expiresAt} mode="date" />.
                        </>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <RemindButton envelopeId={current.id} />
                  <VoidButton envelopeId={current.id} />
                </div>
              </div>
            )}
            {(file.status === "declined" || file.status === "expired" || file.status === "voided" || file.status === "draft") && (
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-red-50 p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <TriangleAlert className="mt-0.5 size-6 shrink-0 text-red" />
                  <div>
                    <p className="text-[17px] font-semibold text-ink">
                      {file.status === "declined" ? "The client declined to sign" : file.status === "expired" ? "The request expired unsigned" : file.status === "voided" ? "The agreement was voided" : "No agreement has been sent"}
                    </p>
                    <p className="text-sm text-ink-2">{decline?.declineReason ? `Their note: "${decline.declineReason}"` : "Work on this file should not start until a new agreement is signed."}</p>
                  </div>
                </div>
                <ResendButton fileId={file.id} />
              </div>
            )}
          </div>

          {undelivered && (
            <div className="mt-4 flex items-start gap-3 rounded-xl border border-red/25 bg-red-50 p-4 text-sm">
              <MailWarning className="mt-0.5 size-5 shrink-0 text-red" />
              <p className="text-ink-2">
                <strong className="font-semibold text-ink">An email to {undelivered.toEmail} was not delivered.</strong> {undelivered.error ? `The mail provider said: ${undelivered.error}. ` : ""}
                The signing link below still works, so you can share it directly.
              </p>
            </div>
          )}
          {justSent && open && !undelivered && (
            <div className="mt-4 flex items-start gap-3 rounded-xl border border-blue/20 bg-blue-50 p-4 text-sm animate-rise">
              {emailConfigured() ? <CircleCheck className="mt-0.5 size-5 shrink-0 text-blue" /> : <MailWarning className="mt-0.5 size-5 shrink-0 text-blue" />}
              <p className="text-ink-2">
                {emailConfigured() ? (
                  <>
                    <strong className="font-semibold text-ink">The agreement is on its way to {pending.map((s) => s.email).join(" and ")}.</strong> You can also share the private link below.
                  </>
                ) : (
                  <>
                    <strong className="font-semibold text-ink">The agreement is ready to sign.</strong> Email delivery is not connected on this deployment, so the message is waiting in your{" "}
                    <Link href="/outbox" className="font-semibold text-blue underline">
                      Outbox
                    </Link>
                    . Share the private link below, or scan the code with a phone.
                  </>
                )}
              </p>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-8 grid gap-8 xl:grid-cols-[1.4fr_1fr]">
        <div className="space-y-8">
          {current && (
            <section>
              <h2 className="display text-[22px]">Signers</h2>
              <Card className="mt-3 divide-y divide-line-2">
                {current.signers.map((s) => {
                  const st = SIGNER_STATUS[s.status];
                  return (
                    <div key={s.id} className="p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[15px] font-semibold">{s.name}</p>
                          <p className="text-sm text-muted">
                            {s.roleLabel}, {s.email}
                          </p>
                        </div>
                        <Badge tone={st.tone}>{st.label}</Badge>
                      </div>
                      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-1 text-[13px]">
                        {s.viewedAt && (
                          <div className="flex gap-1.5">
                            <dt className="text-muted">Opened</dt>
                            <dd>
                              <Time value={s.viewedAt} />
                            </dd>
                          </div>
                        )}
                        {s.signedAt && (
                          <div className="flex gap-1.5">
                            <dt className="text-muted">Signed</dt>
                            <dd>
                              <Time value={s.signedAt} />
                            </dd>
                          </div>
                        )}
                        {s.ip && (
                          <div className="flex gap-1.5">
                            <dt className="text-muted">IP</dt>
                            <dd className="mono">{s.ip}</dd>
                          </div>
                        )}
                      </dl>
                      {open && (s.status === "pending" || s.status === "viewed") && (
                        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-lg bg-paper p-3">
                          <div className="size-[84px] shrink-0 rounded-md bg-white p-1.5 ring-1 ring-line [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: qr.get(s.id) ?? "" }} aria-label="QR code for the signing link" role="img" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] font-semibold text-ink-2">Private signing link</p>
                            <p className="mono mt-0.5 truncate text-muted">{s.url}</p>
                            <div className="mt-2.5 flex flex-wrap gap-2">
                              <CopyButton value={s.url} label="Copy link" />
                              <a href={s.url} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm")}>
                                <ExternalLink className="size-3.5" /> Sign on this device
                              </a>
                              <EditSignerButton signerId={s.id} name={s.name} email={s.email} canRename={!current.signers.some((x) => x.status === "signed")} />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </Card>
            </section>
          )}

          {current && (
            <section>
              <h2 className="display text-[22px]">Record</h2>
              <Card className="mt-3 p-5">
                <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted">Agreement</dt>
                    <dd className="font-semibold">
                      {current.templateName}, version {current.templateVersion}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Document ID</dt>
                    <dd className="mono font-semibold">{current.docId}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Opened by</dt>
                    <dd className="font-semibold">{file.source === "api" ? "Your system (API)" : file.source === "csv" ? "List import" : (file.createdByEmail ?? "Staff")}</dd>
                  </div>
                  {file.externalId && (
                    <div>
                      <dt className="text-muted">Your system&apos;s ID</dt>
                      <dd className="mono font-semibold">{file.externalId}</dd>
                    </div>
                  )}
                  {current.signedSha256 && (
                    <div className="sm:col-span-2">
                      <dt className="text-muted">Fingerprint of the signed PDF (SHA-256)</dt>
                      <dd className="mono mt-0.5 break-all text-ink-2">{current.signedSha256}</dd>
                    </div>
                  )}
                </dl>
                <div className="mt-5 flex flex-wrap gap-2 border-t border-line-2 pt-4">
                  <a href={`/api/documents/source/${current.id}`} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm")}>
                    <FileText className="size-3.5" /> Agreement as sent
                  </a>
                  {current.signedBlobId && (
                    <a href={`/api/documents/signed/${current.id}`} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm")}>
                      <FileText className="size-3.5" /> Signed agreement
                    </a>
                  )}
                  <Link href={`/verify?id=${current.docId}`} className={buttonClass("ghost", "sm")}>
                    <ShieldCheck className="size-3.5" /> Verify
                  </Link>
                </div>
              </Card>
            </section>
          )}
        </div>

        <section>
          <div className="flex items-center justify-between">
            <h2 className="display text-[22px]">Audit trail</h2>
            {current && (auditOk ? <Badge tone="green">Chain intact</Badge> : <Badge tone="red">Chain broken</Badge>)}
          </div>
          <ol className="mt-4">
            {events.map((e, i) => (
              <li key={e.id} className="relative flex gap-3 pb-5">
                {i < events.length - 1 && <span className="absolute top-3 left-[5px] h-full w-px bg-line" aria-hidden />}
                <span
                  className={
                    e.type === "agreement.completed" || e.type === "agreement.signed"
                      ? "relative mt-1.5 size-[11px] shrink-0 rounded-full bg-green ring-4 ring-paper"
                      : e.type === "agreement.declined" || e.type === "agreement.expired" || e.type === "agreement.voided"
                        ? "relative mt-1.5 size-[11px] shrink-0 rounded-full bg-red ring-4 ring-paper"
                        : "relative mt-1.5 size-[11px] shrink-0 rounded-full bg-faint/60 ring-4 ring-paper"
                  }
                />
                <div className="min-w-0 text-sm">
                  <p className="font-semibold">{EVENT_LABEL[e.type] ?? e.type}</p>
                  <p className="text-[13px] text-muted">
                    {e.actor.name}
                    {e.ip ? <span className="mono"> {e.ip}</span> : null}
                  </p>
                  <p className="flex items-center gap-1 text-xs text-faint">
                    <Clock className="size-3" /> <Time value={e.createdAt} />
                  </p>
                </div>
              </li>
            ))}
            {events.length === 0 && <li className="text-sm text-muted">Nothing has happened on this file yet.</li>}
          </ol>
          {envelopes.length > 1 && <p className="mt-2 text-[13px] text-muted">This file has had {envelopes.length} agreements. The trail shows all of them, newest first.</p>}
        </section>
      </div>
    </>
  );
}
