"use client";

import { Time } from "./time";
import clsx from "clsx";
import { ArrowDown, Ban, Check, CircleAlert, Clock, Download, Eye, FileText, Lock, PenLine, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { longDate } from "@/lib/format";
import type { FieldValue, SignatureValue } from "@/lib/types";
import type { SigningField, SigningView } from "@/server/services/signing";
import { FieldValueView, TYPE_LABEL, fieldBox, fieldTextStyle, isSignatureValue } from "./fields";
import { PdfPage, usePdf } from "./pdf";
import { SignatureDialog, SignatureView } from "./signature";
import { buttonClass } from "./button-class";
import { Button, Dialog, Input, Spinner, Textarea } from "./ui";

type Phase = "intro" | "sign" | "done";

function byPosition(a: SigningField, b: SigningField) {
  return a.page - b.page || a.y - b.y || a.x - b.x;
}

async function post(token: string, action: string, body?: unknown) {
  const res = await fetch(`/api/sign/${token}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? "Something went wrong. Try again.");
  return data;
}

function Shell({ view, children, wide }: { view: SigningView; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="h-1" style={{ background: view.firm.brandColor }} />
      <main className={clsx("mx-auto flex w-full flex-1 flex-col justify-center px-5 py-10", wide ? "max-w-2xl" : "max-w-lg")}>{children}</main>
      <footer className="px-5 pb-6 text-center text-xs text-faint">
        Secured by Onfile. Document {view.agreement.docId}
      </footer>
    </div>
  );
}

function FirmMark({ view }: { view: SigningView }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-lg text-sm font-bold text-white" style={{ background: view.firm.brandColor }} aria-hidden>
        {view.firm.name.slice(0, 1).toUpperCase()}
      </span>
      <span className="text-sm font-semibold text-ink">{view.firm.name}</span>
    </div>
  );
}

function Terminal({ view, token }: { view: SigningView; token: string }) {
  const first = view.signer.name.split(" ")[0];
  if (view.state === "completed" || view.state === "waiting") return <Done view={view} token={token} status={view.state} />;
  const copy = {
    declined: {
      icon: <Ban className="size-6" />,
      tone: "bg-red-50 text-red",
      title: "This agreement was declined",
      body: `No signature was recorded. If that was a mistake, contact ${view.firm.name} and they can send a new request.`,
    },
    voided: {
      icon: <CircleAlert className="size-6" />,
      tone: "bg-line-2 text-muted",
      title: "This request was cancelled",
      body: `${view.firm.name} withdrew this agreement, so there is nothing to sign. They will be in touch if a new one is needed.`,
    },
    expired: {
      icon: <Clock className="size-6" />,
      tone: "bg-amber-50 text-amber",
      title: "This signing link has expired",
      body: `${first}, the time to sign this agreement has passed. Ask ${view.firm.name} to send it again.`,
    },
  }[view.state as "declined" | "voided" | "expired"];
  return (
    <Shell view={view}>
      <FirmMark view={view} />
      <div className={clsx("mt-8 grid size-14 place-items-center rounded-full", copy.tone)}>{copy.icon}</div>
      <h1 className="display mt-5 text-[32px]">{copy.title}</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-2">{copy.body}</p>
    </Shell>
  );
}

function Done({ view, token, status }: { view: SigningView; token: string; status: "completed" | "waiting" }) {
  const first = view.signer.name.split(" ")[0];
  const waitingOn = view.others.filter((o) => !o.signed).map((o) => o.name);
  return (
    <Shell view={view}>
      <FirmMark view={view} />
      <div className="mt-8 grid size-16 place-items-center rounded-full bg-green-50">
        <svg viewBox="0 0 32 32" className="size-9" aria-hidden>
          <path d="M7 16.5l6 6L25 10" fill="none" stroke="var(--color-green)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="30" strokeDashoffset="30" className="animate-draw" />
        </svg>
      </div>
      <h1 className="display mt-5 text-[34px]">{status === "completed" ? `All signed. Thank you, ${first}.` : `Your signature is in, ${first}.`}</h1>
      {status === "completed" ? (
        <>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
            {view.firm.name} can now begin work on file {view.file.reference}. A signed copy has been sent to {view.signer.email}, and you can download it here at any time using this same link.
          </p>
          <a href={`/api/sign/${token}/signed`} className={buttonClass("primary", "lg", "mt-7 w-full sm:w-auto")}>
            <Download className="size-4.5" /> Download signed copy
          </a>
        </>
      ) : (
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          The agreement is complete once {waitingOn.join(" and ") || "the other signer"} has signed too. The fully signed copy will be emailed to {view.signer.email}.
        </p>
      )}
      <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-5 text-sm">
        <div>
          <dt className="text-muted">Agreement</dt>
          <dd className="font-semibold">{view.agreement.name}</dd>
        </div>
        <div>
          <dt className="text-muted">Document ID</dt>
          <dd className="mono font-semibold">{view.agreement.docId}</dd>
        </div>
      </dl>
    </Shell>
  );
}

/**
 * Preview mode lets a firm walk through exactly what its client will see, using the real
 * signing screens, before an agreement is published. Nothing is sent, saved or recorded:
 * every network call the real flow makes is skipped.
 */
export interface SigningPreview {
  documentUrl: string;
  backHref: string;
}
const PreviewContext = createContext<SigningPreview | null>(null);

function PreviewBar({ preview }: { preview: SigningPreview }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 bg-ink px-4 py-2 text-center text-[13px] text-white">
      <span className="inline-flex items-center gap-1.5">
        <Eye className="size-3.5" /> Preview. This is what your client sees. Nothing is sent or recorded.
      </span>
      <Link href={preview.backHref} className="font-semibold underline underline-offset-2">
        Back to the editor
      </Link>
    </div>
  );
}

function PreviewDone({ view, preview, onRestart }: { view: SigningView; preview: SigningPreview; onRestart: () => void }) {
  return (
    <Shell view={view}>
      <FirmMark view={view} />
      <div className="mt-8 grid size-14 place-items-center rounded-full bg-blue-50 text-blue">
        <Eye className="size-6" />
      </div>
      <h1 className="display mt-5 text-[32px]">That is the whole client experience</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
        A real client would now see a confirmation and a button to download the signed copy, and the file would be marked cleared to start. Nothing was sent or signed in this preview.
      </p>
      <div className="mt-7 flex flex-wrap gap-2">
        <Link href={preview.backHref} className={buttonClass("primary", "lg")}>
          Back to the editor
        </Link>
        <Button variant="secondary" size="lg" onClick={onRestart}>
          Preview again
        </Button>
      </div>
    </Shell>
  );
}

export function SigningExperience({ token, view, preview }: { token: string; view: SigningView; preview?: SigningPreview }) {
  const [phase, setPhase] = useState<Phase>(view.signer.consented ? "sign" : "intro");
  const [finished, setFinished] = useState<"completed" | "waiting" | "preview" | null>(null);
  const [declined, setDeclined] = useState(false);

  useEffect(() => {
    if (view.state === "sign" && !preview) void post(token, "view").catch(() => {});
  }, [token, view.state, preview]);

  if (preview) {
    return (
      <PreviewContext.Provider value={preview}>
        <PreviewBar preview={preview} />
        {finished ? (
          <PreviewDone
            view={view}
            preview={preview}
            onRestart={() => {
              setFinished(null);
              setPhase("intro");
            }}
          />
        ) : phase === "intro" ? (
          <Intro view={view} token={token} onContinue={() => setPhase("sign")} onDeclined={() => {}} />
        ) : (
          <Signing view={view} token={token} onFinished={setFinished} onDeclined={() => {}} />
        )}
      </PreviewContext.Provider>
    );
  }

  if (declined) return <Terminal view={{ ...view, state: "declined" }} token={token} />;
  if (view.state !== "sign") return <Terminal view={view} token={token} />;
  if (finished && finished !== "preview") return <Done view={view} token={token} status={finished} />;
  if (phase === "intro") return <Intro view={view} token={token} onContinue={() => setPhase("sign")} onDeclined={() => setDeclined(true)} />;
  return <Signing view={view} token={token} onFinished={setFinished} onDeclined={() => setDeclined(true)} />;
}

function DeclineDialog({ open, onClose, token, firm, onDeclined }: { open: boolean; onClose: () => void; token: string; firm: string; onDeclined: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Decline to sign?"
      description={`${firm} will be told you declined, and work on your file will not start. You can add a note so they know why.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Go back
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await post(token, "decline", { reason });
                onDeclined();
              } catch (err) {
                toast.error((err as Error).message);
                setBusy(false);
              }
            }}
          >
            Decline to sign
          </Button>
        </>
      }
    >
      <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Reason (optional)" aria-label="Reason for declining" />
    </Dialog>
  );
}

function Intro({ view, token, onContinue, onDeclined }: { view: SigningView; token: string; onContinue: () => void; onDeclined: () => void }) {
  const preview = useContext(PreviewContext);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const mine = view.fields.filter((f) => f.mine && f.type !== "date");
  const first = view.signer.name.split(" ")[0];

  return (
    <Shell view={view}>
      <FirmMark view={view} />
      <h1 className="display mt-7 text-[36px] sm:text-[40px]">{view.firm.name} needs your signature</h1>
      <p className="mt-4 text-base leading-relaxed text-ink-2">
        Hello {first}. Please review and sign the <strong className="font-semibold text-ink">{view.agreement.name}</strong> for file {view.file.reference}
        {view.file.title ? ` (${view.file.title})` : ""}. Work begins once it is signed.
      </p>

      <ul className="mt-6 divide-y divide-line-2 rounded-xl border border-line bg-surface text-sm">
        <li className="flex items-center gap-3 px-4 py-3">
          <FileText className="size-4.5 shrink-0 text-muted" />
          <span>
            {view.agreement.pages.length} {view.agreement.pages.length === 1 ? "page" : "pages"} to review, sent <Time value={view.agreement.sentAt} mode="date" />
          </span>
        </li>
        <li className="flex items-center gap-3 px-4 py-3">
          <PenLine className="size-4.5 shrink-0 text-muted" />
          <span>
            {mine.length} {mine.length === 1 ? "place" : "places"} for you to complete, about two minutes
          </span>
        </li>
        <li className="flex items-center gap-3 px-4 py-3">
          <Lock className="size-4.5 shrink-0 text-muted" />
          <span>This link is private to {view.signer.email}</span>
        </li>
      </ul>

      <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-4 transition-colors has-checked:border-blue has-checked:bg-blue-50">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[var(--color-blue)]" />
        <span className="text-sm leading-relaxed text-ink-2">
          <span className="font-semibold text-ink">I agree to use electronic records and signatures.</span>
          <details className="mt-1">
            <summary className="text-blue hover:underline">What this means</summary>
            <span className="mt-2 block text-[13px] text-muted">
              You are choosing to sign this agreement electronically instead of on paper. Your electronic signature is as legally binding as a handwritten one. You can download a copy
              before and after signing, and you will be emailed the signed copy. To sign on paper instead, or to withdraw this consent before you sign, contact {view.firm.name}. You
              need a device that can display PDF files.
            </span>
          </details>
        </span>
      </label>

      <Button
        size="lg"
        className="mt-5 w-full"
        disabled={!agreed}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            if (!preview) await post(token, "consent");
            onContinue();
          } catch (err) {
            toast.error((err as Error).message);
            setBusy(false);
          }
        }}
      >
        Review agreement
      </Button>
      {!preview && (
        <button type="button" onClick={() => setDeclining(true)} className="mx-auto mt-4 text-sm text-muted underline-offset-4 hover:text-ink hover:underline">
          I do not want to sign
        </button>
      )}
      <DeclineDialog open={declining} onClose={() => setDeclining(false)} token={token} firm={view.firm.name} onDeclined={onDeclined} />
    </Shell>
  );
}

function Signing({ view, token, onFinished, onDeclined }: { view: SigningView; token: string; onFinished: (s: "completed" | "waiting" | "preview") => void; onDeclined: () => void }) {
  const preview = useContext(PreviewContext);
  const documentUrl = preview ? preview.documentUrl : `/api/sign/${token}/document`;
  const { doc, error } = usePdf(documentUrl);
  const mine = useMemo(() => view.fields.filter((f) => f.mine).sort(byPosition), [view.fields]);
  const [values, setValues] = useState<Record<string, FieldValue>>(() => {
    const init: Record<string, FieldValue> = {};
    for (const f of mine) {
      if (f.value !== undefined) init[f.id] = f.value;
      else if (f.type === "name") init[f.id] = view.signer.name;
    }
    return init;
  });
  const [adopted, setAdopted] = useState<{ signature?: SignatureValue; initials?: SignatureValue }>({});
  const [pad, setPad] = useState<{ id: string; mode: "signature" | "initials" } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [today, setToday] = useState("");
  const [pageWidth, setPageWidth] = useState(800);
  const columnRef = useRef<HTMLDivElement>(null);
  const fieldRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    setToday(longDate(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone));
    const el = columnRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setPageWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const isDone = useCallback(
    (f: SigningField) => {
      const v = values[f.id];
      if (f.type === "date") return true;
      if (f.type === "checkbox") return !f.required || v === true;
      if (f.type === "signature" || f.type === "initials") return isSignatureValue(v) || !f.required;
      return (typeof v === "string" && v.trim().length > 0) || !f.required;
    },
    [values],
  );
  const counted = mine.filter((f) => f.type !== "date" && f.required);
  const doneCount = counted.filter(isDone).length;
  const next = mine.find((f) => !isDone(f)) ?? null;
  const allDone = !next;

  const set = (id: string, v: FieldValue) => setValues((prev) => ({ ...prev, [id]: v }));

  const activate = (f: SigningField) => {
    if (f.type === "signature" || f.type === "initials") {
      const have = adopted[f.type];
      if (have && !isSignatureValue(values[f.id])) set(f.id, have);
      else setPad({ id: f.id, mode: f.type });
    } else if (f.type === "checkbox") set(f.id, values[f.id] !== true);
    else if (f.type !== "date") setEditing(f.id);
  };

  const goTo = (f: SigningField) => {
    const el = fieldRefs.current.get(f.id);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    // Let the scroll settle, then open the right input for the field.
    window.setTimeout(() => activate(f), 420);
  };

  const submit = async () => {
    setBusy(true);
    try {
      if (preview) return void onFinished("preview");
      const r = await post(token, "submit", { consent: true, values, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      onFinished(r.status);
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
      setConfirming(false);
    }
  };

  const editingField = mine.find((f) => f.id === editing) ?? null;
  const pages = view.agreement.pages;

  return (
    <div className="min-h-dvh pb-28">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div className="h-1" style={{ background: view.firm.brandColor }} />
        <div className="mx-auto flex h-14 max-w-[900px] items-center justify-between gap-4 px-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{view.agreement.name}</p>
            <p className="truncate text-xs text-muted">
              {view.firm.name}, file {view.file.reference}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <a href={documentUrl} target="_blank" rel="noreferrer" className={buttonClass("ghost", "sm", "max-sm:hidden")}>
              <Download className="size-3.5" /> Original
            </a>
            {!preview && (
              <Button variant="ghost" size="sm" onClick={() => setDeclining(true)}>
                Decline
              </Button>
            )}
          </div>
        </div>
      </header>

      <div ref={columnRef} className="mx-auto mt-5 w-full max-w-[860px] space-y-5 px-2 sm:px-4">
        {error && (
          <div className="rounded-xl border border-red/30 bg-red-50 p-4 text-sm text-red">
            The document could not be displayed. Reload the page, or open the{" "}
            <a className="underline" href={`/api/sign/${token}/document`}>
              original PDF
            </a>
            .
          </div>
        )}
        {!doc && !error && (
          <div className="flex items-center justify-center gap-2 py-3 text-sm text-muted">
            <Spinner className="size-4" /> Loading your agreement
          </div>
        )}
        {pages.map((size, pageIndex) => {
          const scale = pageWidth / size.width;
          return (
            <PdfPage key={pageIndex} doc={doc} index={pageIndex} size={size}>
              {view.fields
                .filter((f) => f.page === pageIndex)
                .map((f) => {
                  if (!f.mine) {
                    return (
                      <div key={f.id} className="pointer-events-none absolute" style={fieldBox(f)}>
                        <FieldValueView field={f} value={f.value} page={size} />
                      </div>
                    );
                  }
                  const v = values[f.id];
                  const done = isDone(f) && (f.type === "date" || v !== undefined);
                  const isNext = next?.id === f.id;
                  const px = f.h * size.height * scale;
                  const ref = (el: HTMLElement | null) => {
                    if (el) fieldRefs.current.set(f.id, el);
                    else fieldRefs.current.delete(f.id);
                  };

                  if (f.type === "date") {
                    return (
                      <div key={f.id} ref={ref} className="absolute rounded-[3px] bg-blue-50/70 ring-1 ring-blue/25" style={fieldBox(f)} title="Filled in automatically with today's date">
                        <FieldValueView field={f} value={today} page={size} />
                      </div>
                    );
                  }

                  if (f.type === "signature" || f.type === "initials") {
                    const filled = isSignatureValue(v);
                    return (
                      <button
                        key={f.id}
                        ref={ref}
                        type="button"
                        onClick={() => (filled ? setPad({ id: f.id, mode: f.type as "signature" | "initials" }) : activate(f))}
                        style={fieldBox(f)}
                        aria-label={filled ? `Change your ${TYPE_LABEL[f.type].toLowerCase()}` : f.type === "signature" ? "Sign here" : "Add your initials here"}
                        className={clsx(
                          "group absolute rounded-[4px] transition-[background-color,box-shadow]",
                          filled ? "bg-blue-50/50 ring-1 ring-blue/25 hover:bg-blue-50 hover:ring-blue/60" : "bg-flag/85 ring-1 ring-flag-ink/25 hover:bg-flag",
                          isNext && !filled && "animate-pulse-ring",
                        )}
                      >
                        {filled ? (
                          <span className="block size-full p-[0.2cqh]">
                            <SignatureView value={v} />
                          </span>
                        ) : (
                          <span className="flex size-full items-center justify-center gap-[0.6cqw] font-semibold text-flag-ink" style={{ fontSize: `clamp(9px, ${Math.min(px * 0.36, 15)}px, 15px)` }}>
                            <PenLine style={{ width: "1.1em", height: "1.1em" }} />
                            {f.type === "signature" ? "Sign here" : "Initial"}
                          </span>
                        )}
                      </button>
                    );
                  }

                  if (f.type === "checkbox") {
                    return (
                      <button
                        key={f.id}
                        ref={ref}
                        type="button"
                        role="checkbox"
                        aria-checked={v === true}
                        aria-label={f.label ?? "Checkbox"}
                        onClick={() => activate(f)}
                        style={fieldBox(f)}
                        className={clsx("absolute rounded-[3px] ring-1", v === true ? "bg-blue-50/60 ring-blue/40" : "bg-flag/80 ring-flag-ink/30 hover:bg-flag", isNext && "animate-pulse-ring")}
                      >
                        {v === true && <FieldValueView field={f} value={true} page={size} />}
                      </button>
                    );
                  }

                  // Text and name. Inline when the box is big enough to type in comfortably,
                  // otherwise a tap opens a properly sized input (phones).
                  const inline = px >= 24;
                  const label = f.label ?? TYPE_LABEL[f.type];
                  const text = typeof v === "string" ? v : "";
                  if (inline) {
                    return (
                      <input
                        key={f.id}
                        ref={ref}
                        value={text}
                        onChange={(e) => set(f.id, e.target.value)}
                        placeholder={label + (f.required ? "" : " (optional)")}
                        aria-label={label}
                        maxLength={500}
                        autoComplete={f.type === "name" ? "name" : "off"}
                        style={{ ...fieldBox(f), ...fieldTextStyle(f, size, text) }}
                        className={clsx(
                          "field-text absolute rounded-[3px] ring-1 outline-none placeholder:text-flag-ink/60 focus:ring-2 focus:ring-blue",
                          text ? "bg-blue-50/60 ring-blue/25" : f.required ? "bg-flag/70 ring-flag-ink/25" : "bg-flag-50/80 ring-flag-ink/15",
                          isNext && !done && "animate-pulse-ring",
                        )}
                      />
                    );
                  }
                  return (
                    <button
                      key={f.id}
                      ref={ref}
                      type="button"
                      onClick={() => setEditing(f.id)}
                      aria-label={`${label}${text ? `: ${text}` : ""}`}
                      style={fieldBox(f)}
                      className={clsx(
                        "absolute rounded-[3px] text-left ring-1",
                        text ? "bg-blue-50/60 ring-blue/25" : f.required ? "bg-flag/75 ring-flag-ink/25" : "bg-flag-50/80 ring-flag-ink/15",
                        isNext && !done && "animate-pulse-ring",
                      )}
                    >
                      {text ? (
                        <FieldValueView field={f} value={text} page={size} />
                      ) : (
                        <span className="flex size-full items-center overflow-hidden px-[0.6cqw] font-semibold whitespace-nowrap text-flag-ink" style={{ fontSize: "max(8px, 1.15cqh)" }}>
                          {label}
                        </span>
                      )}
                    </button>
                  );
                })}
            </PdfPage>
          );
        })}
        <p className="flex items-center justify-center gap-1.5 pt-1 pb-2 text-xs text-faint">
          <ShieldCheck className="size-3.5" /> Document {view.agreement.docId}. Every action on this page is recorded in the audit trail.
        </p>
      </div>

      {/* Action bar: always says exactly what to do next. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_-12px_rgb(14_26_43/0.18)] backdrop-blur">
        <div className="h-1 bg-line-2" aria-hidden>
          <div className="h-full bg-blue transition-[width] duration-500" style={{ width: `${counted.length ? (doneCount / counted.length) * 100 : 100}%` }} />
        </div>
        <div className="mx-auto flex max-w-[900px] items-center justify-between gap-4 px-4 py-3">
          <p className="min-w-0 text-sm" aria-live="polite">
            <span className="tabular font-semibold">
              {doneCount} of {counted.length}
            </span>{" "}
            <span className="text-muted">
              {allDone ? "done" : "required"}
              <span className="max-sm:hidden">{allDone ? ". Ready to finish." : " fields complete"}</span>
            </span>
          </p>
          {allDone ? (
            <Button size="lg" onClick={() => setConfirming(true)} className="shrink-0">
              <Check className="size-4.5" /> Finish signing
            </Button>
          ) : (
            <Button size="lg" variant="flag" onClick={() => next && goTo(next)} className="shrink-0">
              <ArrowDown className="size-4.5" />
              {doneCount === 0 ? "Start" : "Next"}: {next!.type === "signature" ? "sign" : next!.type === "initials" ? "initial" : (next!.label ?? TYPE_LABEL[next!.type]).toLowerCase()}
            </Button>
          )}
        </div>
      </div>

      <SignatureDialog
        open={Boolean(pad)}
        mode={pad?.mode ?? "signature"}
        name={view.signer.name}
        onClose={() => setPad(null)}
        onAdopt={(sig) => {
          if (!pad) return;
          set(pad.id, sig);
          setAdopted((a) => ({ ...a, [pad.mode]: sig }));
          setPad(null);
        }}
      />

      <Dialog
        open={Boolean(editingField)}
        onClose={() => setEditing(null)}
        size="sm"
        title={editingField?.label ?? (editingField ? TYPE_LABEL[editingField.type] : "")}
        footer={<Button onClick={() => setEditing(null)}>Done</Button>}
      >
        {editingField && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setEditing(null);
            }}
          >
            <Input
              autoFocus
              value={typeof values[editingField.id] === "string" ? (values[editingField.id] as string) : ""}
              onChange={(e) => set(editingField.id, e.target.value)}
              maxLength={500}
              autoComplete={editingField.type === "name" ? "name" : "off"}
              aria-label={editingField.label ?? TYPE_LABEL[editingField.type]}
              className="h-12 text-base"
            />
          </form>
        )}
      </Dialog>

      <Dialog
        open={confirming}
        onClose={() => !busy && setConfirming(false)}
        size="sm"
        title="Finish signing?"
        description={
          <>
            You are signing the {view.agreement.name} as <strong className="text-ink">{view.signer.name}</strong>. This is legally binding. A signed copy goes to {view.signer.email}.
          </>
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Keep reviewing
            </Button>
            <Button onClick={submit} loading={busy}>
              Sign and finish
            </Button>
          </>
        }
      />
      <DeclineDialog open={declining} onClose={() => setDeclining(false)} token={token} firm={view.firm.name} onDeclined={onDeclined} />
    </div>
  );
}
