import { Time } from "@/components/time";
import { Check, ChevronRight, Eye, FolderPlus, MailCheck, Upload } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Card, LinkButton, PageHeader, StatusPill } from "@/components/ui";
import { UploadZone } from "@/components/upload-zone";
import { EVENT_LABEL, formatDuration } from "@/lib/format";
import { requireCtx } from "@/server/auth";
import { dashboard } from "@/server/services/files";
import { listTemplates } from "@/server/services/templates";

export const metadata: Metadata = { title: "Overview" };

function Step({ n, done, current, title, children }: { n: number; done: boolean; current: boolean; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span
        className={
          done
            ? "grid size-8 shrink-0 place-items-center rounded-full bg-green text-white"
            : current
              ? "grid size-8 shrink-0 place-items-center rounded-full bg-blue text-sm font-bold text-white"
              : "grid size-8 shrink-0 place-items-center rounded-full border border-line text-sm font-bold text-faint"
        }
      >
        {done ? <Check className="size-4" strokeWidth={3} /> : n}
      </span>
      <div className="min-w-0 flex-1 pb-7">
        <h3 className={current || done ? "text-[15px] font-semibold" : "text-[15px] font-semibold text-muted"}>{title}</h3>
        {children}
      </div>
    </li>
  );
}

export default async function DashboardPage() {
  const { ctx, user } = await requireCtx();
  const [stats, templates] = await Promise.all([dashboard(ctx), listTemplates(ctx)]);
  const live = templates.find((t) => t.status === "active");
  const draft = templates.find((t) => t.status === "draft");
  const first = user.name.split(" ")[0];

  if (!live || stats.total === 0) {
    return (
      <div className="max-w-2xl">
        <PageHeader title={`Welcome, ${first}`} description="Set this up once. After that, opening a file is all it takes: the agreement goes out, reminders follow, and the signed copy files itself." />
        <Card className="p-6 sm:p-8">
          <ol>
            <Step n={1} done={Boolean(live || draft)} current={!live && !draft} title="Upload the agreement you already use">
              {!live && !draft ? (
                <div className="mt-3">
                  <UploadZone compact />
                </div>
              ) : (
                <p className="mt-1 text-sm text-muted">{(live ?? draft)!.name}</p>
              )}
            </Step>
            <Step n={2} done={Boolean(live)} current={!live && Boolean(draft)} title="Check the fields Onfile found, then publish">
              {!live && draft ? (
                <div className="mt-3">
                  <LinkButton href={`/agreements/${draft.id}`}>Review and publish</LinkButton>
                </div>
              ) : (
                <p className="mt-1 text-sm text-muted">Signature lines, dates and blanks are detected for you. You confirm them.</p>
              )}
            </Step>
            <Step n={3} done={false} current={Boolean(live)} title="Open your first file">
              {live ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <LinkButton href="/files/new">
                    <FolderPlus className="size-4" /> Open a file
                  </LinkButton>
                  <LinkButton href="/files/import" variant="secondary">
                    <Upload className="size-4" /> Import a list
                  </LinkButton>
                </div>
              ) : (
                <p className="mt-1 text-sm text-muted">Enter the client&apos;s name and email. They get a private link to sign on any device.</p>
              )}
            </Step>
          </ol>
        </Card>
      </div>
    );
  }

  const waiting = stats.open.filter((f) => f.status === "awaiting_signature");
  const blocked = stats.open.filter((f) => f.status !== "awaiting_signature");

  return (
    <>
      <PageHeader
        title="Overview"
        description={stats.awaiting === 0 ? "Nothing is waiting on a signature right now." : `${stats.awaiting} ${stats.awaiting === 1 ? "file is" : "files are"} waiting on a client signature.`}
        actions={
          <LinkButton href="/files/new">
            <FolderPlus className="size-4" /> Open a file
          </LinkButton>
        }
      />

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-4">
        {[
          { label: "Awaiting signature", value: String(stats.awaiting), note: stats.awaiting ? "Work is on hold for these" : "All clear", href: "/files?status=awaiting_signature" },
          { label: "Signed", value: String(stats.signed), note: stats.signedThisWeek ? `${stats.signedThisWeek} in the last 7 days` : "None in the last 7 days", href: "/files?status=signed" },
          { label: "Typical time to sign", value: stats.medianMs == null ? "No data" : formatDuration(stats.medianMs), note: "Median, last 90 days" },
          { label: "Signed after being sent", value: stats.completionRate == null ? "No data" : `${Math.round(stats.completionRate * 100)}%`, note: stats.blocked ? `${stats.blocked} declined or expired` : "None declined or expired" },
        ].map((k) => {
          const body = (
            <>
              <dt className="text-[13px] font-semibold text-muted">{k.label}</dt>
              <dd className="display tabular mt-2 text-[34px]">{k.value}</dd>
              <dd className="mt-1 text-[13px] text-muted">{k.note}</dd>
            </>
          );
          return k.href ? (
            <Link key={k.label} href={k.href} className="bg-surface p-5 transition-colors hover:bg-blue-50/40">
              {body}
            </Link>
          ) : (
            <div key={k.label} className="bg-surface p-5">
              {body}
            </div>
          );
        })}
      </dl>

      <div className="mt-8 grid gap-8 xl:grid-cols-[1.5fr_1fr]">
        <section>
          <h2 className="display text-[22px]">Waiting on clients</h2>
          <Card className="mt-3 divide-y divide-line-2 overflow-hidden">
            {[...blocked, ...waiting].slice(0, 9).map((f) => (
              <Link key={f.id} href={`/files/${f.id}`} className="flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-paper sm:px-5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold">{f.clientName}</p>
                  <p className="truncate text-[13px] text-muted">
                    <span className="mono">{f.reference}</span>
                    {f.title ? `  ${f.title}` : ""}
                  </p>
                </div>
                <div className="text-right max-sm:hidden">
                  {f.status === "awaiting_signature" ? (
                    <p className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
                      {f.viewed ? <Eye className="size-3.5 text-blue" /> : <MailCheck className="size-3.5 text-faint" />}
                      {f.viewed ? "Opened, not signed" : "Not opened yet"}
                    </p>
                  ) : (
                    <StatusPill status={f.status} />
                  )}
                  <p className="text-xs text-faint">Sent <Time value={f.envelope?.sentAt ?? f.createdAt} mode="ago" /></p>
                </div>
                <ChevronRight className="size-4 shrink-0 text-faint" />
              </Link>
            ))}
            {stats.open.length === 0 && <p className="px-5 py-10 text-center text-sm text-muted">Every file you have opened is signed.</p>}
          </Card>
          {stats.open.length > 9 && (
            <Link href="/files?status=awaiting_signature" className="mt-3 inline-block text-sm font-semibold text-blue hover:underline">
              See all {stats.open.length}
            </Link>
          )}
        </section>

        <section>
          <h2 className="display text-[22px]">Latest activity</h2>
          <ol className="mt-3 space-y-0">
            {stats.recent.map((e, i) => (
              <li key={e.id} className="relative flex gap-3 pb-4">
                {i < stats.recent.length - 1 && <span className="absolute top-3 left-[5px] h-full w-px bg-line" aria-hidden />}
                <span
                  className={
                    e.type === "agreement.completed" || e.type === "agreement.signed"
                      ? "relative mt-1.5 size-[11px] shrink-0 rounded-full bg-green ring-4 ring-paper"
                      : e.type === "agreement.declined" || e.type === "agreement.expired"
                        ? "relative mt-1.5 size-[11px] shrink-0 rounded-full bg-red ring-4 ring-paper"
                        : "relative mt-1.5 size-[11px] shrink-0 rounded-full bg-line ring-4 ring-paper"
                  }
                />
                <Link href={`/files/${e.fileId}`} className="min-w-0 flex-1 text-sm hover:underline">
                  <span className="font-semibold">{EVENT_LABEL[e.type] ?? e.type}</span>
                  <span className="text-muted">
                    {" "}
                    for {e.clientName} <span className="mono">{e.reference}</span>
                  </span>
                  <span className="block text-xs text-faint">
                    <Time value={e.createdAt} mode="ago" />
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
