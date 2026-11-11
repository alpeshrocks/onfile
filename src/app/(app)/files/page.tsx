import { Time } from "@/components/time";
import { Eye, FolderOpen, FolderPlus, Search, Upload } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, LinkButton, PageHeader, StatusPill } from "@/components/ui";
import { formatDuration } from "@/lib/format";
import { FILE_STATUS_LABEL, type FileStatus } from "@/lib/types";
import { requireCtx } from "@/server/auth";
import { listFiles } from "@/server/services/files";

export const metadata: Metadata = { title: "Files" };

const TABS: (FileStatus | "all")[] = ["all", "awaiting_signature", "signed", "declined", "expired", "voided"];

export default async function FilesPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const { ctx } = await requireCtx();
  const params = await searchParams;
  const status = (TABS.includes(params.status as FileStatus) ? params.status : "all") as FileStatus | "all";
  const q = params.q?.slice(0, 80) ?? "";
  const [rows, all] = await Promise.all([listFiles(ctx, { status, q }), listFiles(ctx, { limit: 1000 })]);
  const counts = all.reduce<Record<string, number>>((acc, f) => ((acc[f.status] = (acc[f.status] ?? 0) + 1), acc), { all: all.length });
  const link = (s: string) => `/files?${new URLSearchParams({ ...(s !== "all" ? { status: s } : {}), ...(q ? { q } : {}) })}`;

  return (
    <>
      <PageHeader
        title="Files"
        description="One file per job or case. Each one is sent its agreement the moment it is opened."
        actions={
          <>
            <LinkButton href="/files/import" variant="secondary">
              <Upload className="size-4" /> Import a list
            </LinkButton>
            <LinkButton href="/files/new">
              <FolderPlus className="size-4" /> Open a file
            </LinkButton>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1" aria-label="Filter by status">
          {TABS.filter((t) => t === "all" || t === "awaiting_signature" || t === "signed" || counts[t]).map((t) => (
            <Link
              key={t}
              href={link(t)}
              aria-current={status === t ? "page" : undefined}
              className={
                status === t
                  ? "inline-flex h-9 items-center gap-2 rounded-full bg-ink px-3.5 text-[13px] font-semibold text-white"
                  : "inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold text-ink-2 hover:bg-line-2"
              }
            >
              {t === "all" ? "All" : FILE_STATUS_LABEL[t]}
              <span className={status === t ? "tabular text-white/70" : "tabular text-faint"}>{counts[t] ?? 0}</span>
            </Link>
          ))}
        </nav>
        <form action="/files" className="relative">
          {status !== "all" && <input type="hidden" name="status" value={status} />}
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <input
            name="q"
            defaultValue={q}
            placeholder="Search client, reference, email"
            aria-label="Search files"
            className="h-9 w-64 rounded-full border border-line bg-surface pr-3 pl-9 text-sm placeholder:text-faint focus:border-blue focus:outline-none focus:ring-3 focus:ring-blue/15"
          />
        </form>
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            icon={<FolderOpen className="size-5.5" />}
            title={q ? "No files match that search" : all.length ? "Nothing here" : "No files yet"}
            action={!q && !all.length ? <LinkButton href="/files/new">Open your first file</LinkButton> : undefined}
          >
            {q ? "Try a client name, a reference or an email address." : all.length ? "No files have this status." : "Open a file and its agreement is sent to the client straight away."}
          </EmptyState>
        ) : (
          <div role="table" aria-label="Files">
            <div role="row" className="grid grid-cols-[110px_1fr_auto] gap-4 border-b border-line-2 bg-paper/60 px-5 py-2.5 text-xs font-semibold text-muted sm:grid-cols-[110px_1.4fr_1fr_170px]">
              <span role="columnheader">Reference</span>
              <span role="columnheader">Client</span>
              <span role="columnheader" className="max-sm:hidden">
                Where it stands
              </span>
              <span role="columnheader">Status</span>
            </div>
            {rows.map((f) => {
              const sent = f.envelope?.sentAt;
              let note = "";
              if (f.status === "signed" && f.envelope?.completedAt && sent) note = `Signed in ${formatDuration(f.envelope.completedAt.getTime() - sent.getTime())}`;
              else if (f.status === "awaiting_signature") note = f.signedCount > 0 ? `${f.signedCount} of ${f.signerCount} signed` : f.viewed ? "Opened, not signed" : "Not opened yet";
              else if (f.status !== "draft") note = FILE_STATUS_LABEL[f.status];
              return (
                <Link
                  key={f.id}
                  href={`/files/${f.id}`}
                  role="row"
                  className="grid grid-cols-[110px_1fr_auto] items-center gap-4 border-b border-line-2 px-5 py-3.5 transition-colors last:border-0 hover:bg-paper sm:grid-cols-[110px_1.4fr_1fr_170px]"
                >
                  <span role="cell" className="mono truncate font-semibold text-ink-2">
                    {f.reference}
                  </span>
                  <span role="cell" className="min-w-0">
                    <span className="block truncate text-[15px] font-semibold">{f.clientName}</span>
                    <span className="block truncate text-[13px] text-muted">{f.title || f.clientEmail}</span>
                  </span>
                  <span role="cell" className="min-w-0 text-[13px] text-ink-2 max-sm:hidden">
                    <span className="inline-flex items-center gap-1.5">
                      {f.status === "awaiting_signature" && f.viewed && <Eye className="size-3.5 text-blue" />}
                      {note}
                    </span>
                    <span className="block text-xs text-faint">
                      {sent ? "Sent " : "Opened "}
                      <Time value={sent ?? f.createdAt} mode="ago" />
                    </span>
                  </span>
                  <span role="cell">
                    <StatusPill status={f.status} />
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}
