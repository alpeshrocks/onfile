"use client";

import { Time } from "./time";
import clsx from "clsx";
import { Mail } from "lucide-react";
import { useState } from "react";
import { Badge, Card, EmptyState } from "./ui";

export interface OutboxEmail {
  id: string;
  kind: string;
  toEmail: string;
  toName: string;
  subject: string;
  html: string;
  status: "delivered" | "captured" | "failed";
  error: string | null;
  createdAt: string;
}

const KIND: Record<string, string> = {
  signature_request: "Signature request",
  reminder: "Reminder",
  completed: "Signed copy",
  firm_notice: "Notice to your team",
};

export function OutboxView({ emails }: { emails: OutboxEmail[] }) {
  const [selectedId, setSelectedId] = useState(emails[0]?.id ?? null);
  const selected = emails.find((e) => e.id === selectedId) ?? null;

  if (!emails.length) {
    return (
      <Card>
        <EmptyState icon={<Mail className="size-5.5" />} title="No messages yet">
          Every email Onfile sends for you appears here: signature requests, reminders and signed copies.
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
      <Card className="scroll-thin max-h-[70dvh] divide-y divide-line-2 overflow-y-auto">
        {emails.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => setSelectedId(e.id)}
            aria-current={e.id === selectedId}
            className={clsx("block w-full px-4 py-3 text-left transition-colors", e.id === selectedId ? "bg-blue-50" : "hover:bg-paper")}
          >
            <span className="flex items-center justify-between gap-3">
              <span className="truncate text-sm font-semibold">{e.toName || e.toEmail}</span>
              <span className="shrink-0 text-xs text-faint">
                <Time value={e.createdAt} mode="ago" />
              </span>
            </span>
            <span className="mt-0.5 block truncate text-[13px] text-ink-2">{e.subject}</span>
            <span className="mt-1.5 flex items-center gap-1.5">
              <Badge>{KIND[e.kind] ?? e.kind}</Badge>
              {e.status === "delivered" ? <Badge tone="green">Delivered</Badge> : e.status === "failed" ? <Badge tone="red">Failed</Badge> : <Badge tone="amber">Held in Outbox</Badge>}
            </span>
          </button>
        ))}
      </Card>

      {selected && (
        <Card className="overflow-hidden">
          <dl className="grid grid-cols-[64px_1fr] gap-y-1 border-b border-line-2 px-5 py-4 text-sm">
            <dt className="text-muted">To</dt>
            <dd className="font-semibold">
              {selected.toName ? `${selected.toName} ` : ""}
              <span className="font-normal text-ink-2">{selected.toEmail}</span>
            </dd>
            <dt className="text-muted">Subject</dt>
            <dd className="font-semibold">{selected.subject}</dd>
            <dt className="text-muted">Sent</dt>
            <dd>
              <Time value={selected.createdAt} />
            </dd>
            {selected.error && (
              <>
                <dt className="text-muted">Error</dt>
                <dd className="text-red">{selected.error}</dd>
              </>
            )}
          </dl>
          {/* Sandboxed: the email renders exactly as sent, but can run nothing. */}
          <iframe title="Email preview" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={selected.html} className="h-[560px] w-full bg-[#F3F5F8]" />
        </Card>
      )}
    </div>
  );
}
