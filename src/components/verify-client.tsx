"use client";

import clsx from "clsx";
import { CircleCheck, CircleX, FileSearch, ShieldAlert } from "lucide-react";
import { useRef, useState } from "react";
import { verifyAction } from "@/app/actions";
import { formatDateTime } from "@/lib/format";
import { Button, Card, Input, Spinner } from "./ui";

type Result = Extract<Awaited<ReturnType<typeof verifyAction>>, { ok: true }>["result"];

async function sha256(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Anyone holding a signed PDF can check it. The file never leaves the browser: only its
 * SHA-256 fingerprint is sent and compared with the one registered at signing.
 */
export function VerifyClient({ initialId }: { initialId: string }) {
  const [docId, setDocId] = useState(initialId);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [result, setResult] = useState<{ r: Result; fileName?: string } | null>(null);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const check = async (query: { docId?: string; sha256?: string }, fileName?: string) => {
    setBusy(true);
    setError("");
    const r = await verifyAction(query);
    setBusy(false);
    if (!r.ok) return void setError(r.error);
    setResult({ r: r.result, fileName });
  };

  const checkFile = async (file: File) => {
    setBusy(true);
    await check({ sha256: await sha256(file) }, file.name);
  };

  return (
    <div className="space-y-5">
      <div
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f) void checkFile(f);
        }}
        className={clsx(
          "flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
          over ? "border-blue bg-blue-50" : "border-line bg-surface hover:border-blue/60",
        )}
      >
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void checkFile(f);
          }}
        />
        {busy ? <Spinner className="size-6 text-blue" /> : <FileSearch className="size-7 text-blue" />}
        <p className="mt-3 text-[15px] font-semibold">Drop a signed PDF here to check it</p>
        <p className="mt-1 text-sm text-muted">The file stays on your device. Only its fingerprint is compared.</p>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (docId.trim()) void check({ docId: docId.trim() });
        }}
      >
        <Input value={docId} onChange={(e) => setDocId(e.target.value)} placeholder="Or enter a document ID: ONF-XXXX-XXXX-XXXX" className="mono" aria-label="Document ID" />
        <Button type="submit" variant="secondary" disabled={!docId.trim()} loading={busy}>
          Look up
        </Button>
      </form>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      {result && !result.r.found && (
        <Card className="border-red/30 p-5 animate-rise">
          <div className="flex items-start gap-3">
            <CircleX className="mt-0.5 size-6 shrink-0 text-red" />
            <div>
              <h2 className="text-[17px] font-semibold">{result.r.reason === "no_match" ? "This file does not match any signed record" : "No record with that document ID"}</h2>
              <p className="mt-1 text-sm text-ink-2">
                {result.r.reason === "no_match"
                  ? "Either it was not signed through Onfile, or it has been changed since signing. Even a one-character edit changes the fingerprint. Ask the sender for the original signed copy."
                  : "Check the ID printed at the top of each page of the signed document."}
              </p>
            </div>
          </div>
        </Card>
      )}

      {result && result.r.found && (
        <Card className={clsx("p-5 animate-rise sm:p-6", result.r.auditIntact ? "border-green/40" : "border-amber/40")}>
          <div className="flex items-start gap-3">
            {result.r.auditIntact ? <CircleCheck className="mt-0.5 size-6 shrink-0 text-green" /> : <ShieldAlert className="mt-0.5 size-6 shrink-0 text-amber" />}
            <div>
              <h2 className="text-[17px] font-semibold">
                {result.r.matchedBy === "fingerprint" ? "Genuine. This file is exactly what was signed." : result.r.status === "completed" ? "A signed record exists for this ID" : "A record exists, but it is not fully signed"}
              </h2>
              <p className="mt-1 text-sm text-ink-2">
                {result.r.matchedBy === "fingerprint"
                  ? `${result.fileName ?? "The file"} matches the fingerprint registered when signing finished. Nothing has been altered.`
                  : "To confirm a particular copy is unaltered, drop the PDF above."}
                {!result.r.auditIntact && " Warning: this record's audit trail failed its integrity check."}
              </p>
            </div>
          </div>
          <dl className="mt-5 grid gap-x-8 gap-y-3 border-t border-line-2 pt-5 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">Agreement</dt>
              <dd className="font-semibold">{result.r.agreement}</dd>
            </div>
            <div>
              <dt className="text-muted">Sent by</dt>
              <dd className="font-semibold">{result.r.firm}</dd>
            </div>
            <div>
              <dt className="text-muted">Document ID</dt>
              <dd className="mono font-semibold">{result.r.docId}</dd>
            </div>
            <div>
              <dt className="text-muted">Completed</dt>
              <dd className="font-semibold">{result.r.completedAt ? formatDateTime(result.r.completedAt) : "Not completed"}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted">Signed by</dt>
              <dd className="mt-1 space-y-1">
                {result.r.signers.map((s, i) => (
                  <p key={i}>
                    <span className="font-semibold">{s.name}</span>{" "}
                    <span className="text-muted">
                      {s.role}, {s.email}
                      {s.signedAt ? `, ${formatDateTime(s.signedAt)}` : ", not signed"}
                    </span>
                  </p>
                ))}
              </dd>
            </div>
            {result.r.signedSha256 && (
              <div className="sm:col-span-2">
                <dt className="text-muted">Registered fingerprint (SHA-256)</dt>
                <dd className="mono mt-0.5 break-all text-ink-2">{result.r.signedSha256}</dd>
              </div>
            )}
          </dl>
        </Card>
      )}
    </div>
  );
}
