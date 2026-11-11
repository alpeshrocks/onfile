"use client";

import clsx from "clsx";
import {
  ArrowLeft,
  CalendarDays,
  Check,
  CheckSquare,
  CircleAlert,
  CircleCheck,
  Copy,
  FilePlus2,
  Fingerprint,
  PenLine,
  Plus,
  ScanSearch,
  Sparkles,
  Trash2,
  TriangleAlert,
  Type,
  UserRound,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { addSignaturePageAction, saveTemplateAction } from "@/app/actions";
import { detectFields } from "@/lib/detect";
import { slugKey } from "@/lib/format";
import { clampRect } from "@/lib/geometry";
import { AUTO, BUILTIN_VARIABLES, type Field, type FieldType, type FirmSigner, type PageSize, type Role, type Variable } from "@/lib/types";
import { templateIssues } from "@/lib/validate";
import { TYPE_LABEL, fieldBox } from "./fields";
import { FirmSignerDialog } from "./firm-signer";
import { PdfPage, extractForDetection, usePdf } from "./pdf";
import { Badge, Button, Dialog, Field as FormField, Input, LinkButton, Select, Spinner, Textarea } from "./ui";

export interface EditorTemplate {
  id: string;
  name: string;
  status: "draft" | "active" | "archived";
  version: number;
  isDefault: boolean;
  sha256: string;
  pages: PageSize[];
  fields: Field[];
  roles: Role[];
  variables: Variable[];
  detected: boolean;
  emailSubject: string;
  emailMessage: string;
}

const TYPE_ICON: Record<FieldType, typeof PenLine> = {
  signature: PenLine,
  initials: Fingerprint,
  date: CalendarDays,
  name: UserRound,
  text: Type,
  checkbox: CheckSquare,
};

function defaultSize(type: FieldType, page: PageSize) {
  switch (type) {
    case "signature":
      return { w: 0.3, h: 0.052 };
    case "initials":
      return { w: 0.09, h: 0.036 };
    case "checkbox":
      return { w: 16 / page.width, h: 16 / page.height };
    case "date":
      return { w: 0.18, h: 0.026 };
    default:
      return { w: 0.28, h: 0.026 };
  }
}

/** Colour encodes who fills a field: yellow for the client, teal for a co-signer, blue for automatic. */
function tone(assignee: string, roles: Role[]) {
  if (assignee === AUTO) return { box: "bg-blue-100/70 ring-blue/50 text-blue-dark", dot: "bg-blue", solid: "bg-blue" };
  if (assignee === roles[0]?.key) return { box: "bg-flag/70 ring-flag-ink/40 text-flag-ink", dot: "bg-flag", solid: "bg-flag-ink" };
  return { box: "bg-teal-50/90 ring-teal/50 text-teal", dot: "bg-teal", solid: "bg-teal" };
}

let idCounter = 0;
const newFieldId = () => `f${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export function TemplateEditor({ template, firmName, firmSigner: initialFirmSigner }: { template: EditorTemplate; firmName: string; firmSigner: FirmSigner | null }) {
  const [name, setName] = useState(template.name);
  const [fields, setFields] = useState<Field[]>(template.fields);
  const [roles, setRoles] = useState<Role[]>(template.roles);
  const [variables, setVariables] = useState<Variable[]>(template.variables);
  const [emailSubject, setEmailSubject] = useState(template.emailSubject);
  const [emailMessage, setEmailMessage] = useState(template.emailMessage);
  const [pages, setPages] = useState(template.pages);
  const [sha, setSha] = useState(template.sha256);
  const [status, setStatus] = useState(template.status);
  const [version, setVersion] = useState(template.version);
  const [firmSigner, setFirmSigner] = useState(initialFirmSigner);
  const [isDefault, setIsDefault] = useState(template.isDefault);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assignee, setAssignee] = useState<string>(template.roles[0]?.key ?? AUTO);
  const [placing, setPlacing] = useState<FieldType | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [detecting, setDetecting] = useState(!template.detected);
  const [detectedCount, setDetectedCount] = useState<number | null>(null);
  const [firmDialog, setFirmDialog] = useState(false);
  const [published, setPublished] = useState(false);
  const [busy, setBusy] = useState<"publish" | "page" | null>(null);

  const { doc, error } = usePdf(`/api/documents/template/${template.id}?v=${sha.slice(0, 12)}`);
  const overlays = useRef(new Map<number, HTMLDivElement>());
  const isLive = status === "active";

  const issues = useMemo(() => templateIssues({ fields, roles, variables, pageCount: pages.length }, Boolean(firmSigner)), [fields, roles, variables, pages.length, firmSigner]);
  const errors = issues.filter((i) => i.level === "error");
  const selected = fields.find((f) => f.id === selectedId) ?? null;
  const patch = useMemo(() => ({ name: name.trim() || template.name, fields, roles, variables, emailSubject, emailMessage }), [name, fields, roles, variables, emailSubject, emailMessage, template.name]);

  // ---- First visit: read the agreement and propose fields -------------------
  const runDetection = useCallback(
    async (replace: boolean) => {
      if (!doc) return;
      setDetecting(true);
      try {
        const extracted = await extractForDetection(doc);
        const found = detectFields(extracted.pages, extracted.widgets, { firmName });
        setFields((prev) => {
          const keep = replace ? prev.filter((f) => f.source === "manual" || f.source === "generated") : prev;
          const fresh = found.fields.map((f) => ({ ...f, id: newFieldId() }));
          return [...keep, ...fresh];
        });
        setRoles((prev) => {
          const keys = new Set(prev.map((r) => r.key));
          return [...prev, ...found.roles.filter((r) => !keys.has(r.key))];
        });
        setVariables((prev) => {
          const keys = new Set(prev.map((v) => v.key));
          return [...prev, ...found.variables.filter((v) => !keys.has(v.key))];
        });
        setDetectedCount(found.fields.length);
        saved.current = ""; // always persist the result, even when nothing was found
        if (replace) toast.success(found.fields.length ? `Found ${found.fields.length} fields` : "No fields found in the text of this document");
      } catch {
        setDetectedCount(0);
      } finally {
        setDetecting(false);
      }
    },
    [doc, firmName],
  );

  const detectedOnce = useRef(template.detected);
  useEffect(() => {
    if (doc && !detectedOnce.current) {
      detectedOnce.current = true;
      void runDetection(false);
    }
  }, [doc, runDetection]);

  // ---- Saving ---------------------------------------------------------------
  // Compare against the last state the server accepted, so only real edits count as
  // changes (publishing or a re-render never marks the agreement dirty).
  const serialized = useMemo(() => JSON.stringify(patch), [patch]);
  const saved = useRef(serialized);
  useEffect(() => {
    if (detecting || serialized === saved.current) return;
    setSaveState("dirty");
    if (isLive) return; // live agreements save explicitly, with validation
    const timer = setTimeout(async () => {
      setSaveState("saving");
      const r = await saveTemplateAction(template.id, JSON.parse(serialized));
      if (r.ok) saved.current = serialized;
      setSaveState(r.ok ? "saved" : "error");
      if (!r.ok) toast.error(r.error);
    }, 900);
    return () => clearTimeout(timer);
  }, [serialized, isLive, template.id, detecting]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (saveState === "dirty" || saveState === "saving") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState]);

  const publish = async () => {
    if (errors.length) {
      toast.error(errors[0].message);
      if (errors[0].fieldId) setSelectedId(errors[0].fieldId);
      return;
    }
    setBusy("publish");
    const r = await saveTemplateAction(template.id, patch, !isLive);
    setBusy(null);
    if (!r.ok) return void toast.error(r.error);
    saved.current = serialized;
    setSaveState("saved");
    setVersion(r.version);
    setIsDefault(r.isDefault);
    if (!isLive) {
      setStatus("active");
      setPublished(true);
    } else toast.success(`Saved as version ${r.version}. New files use it from now on.`);
  };

  const addSignaturePage = async () => {
    setBusy("page");
    // Persist current edits first so the server appends to the latest state.
    if (!isLive) await saveTemplateAction(template.id, patch);
    const r = await addSignaturePageAction(template.id, Boolean(firmSigner) || fields.some((f) => f.assignee === AUTO && f.type === "signature"));
    setBusy(null);
    if (!r.ok) return void toast.error(r.error);
    setFields(r.fields);
    setPages(r.pages);
    setSha(r.sha256);
    toast.success("Signature page added at the end");
    setTimeout(() => document.querySelector(`[data-page="${r.pages.length - 1}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 400);
  };

  // ---- Field manipulation ---------------------------------------------------
  const update = (id: string, change: Partial<Field>) => setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...change, source: f.source === "detected" ? "manual" : f.source, confidence: 1 } : f)));
  const remove = (id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id));
    setSelectedId(null);
  };
  const duplicate = (f: Field) => {
    const copy = { ...f, id: newFieldId(), ...clampRect({ x: f.x + 0.015, y: f.y + f.h + 0.008, w: f.w, h: f.h }), source: "manual" as const };
    setFields((prev) => [...prev, copy]);
    setSelectedId(copy.id);
  };

  const place = (pageIndex: number, e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (!placing) return void setSelectedId(null);
    const rect = e.currentTarget.getBoundingClientRect();
    const size = defaultSize(placing, pages[pageIndex]);
    const f: Field = {
      id: newFieldId(),
      type: placing,
      page: pageIndex,
      ...clampRect({ x: (e.clientX - rect.left) / rect.width - size.w / 2, y: (e.clientY - rect.top) / rect.height - size.h / 2, ...size }),
      assignee,
      required: placing !== "checkbox",
      source: "manual",
      ...(assignee === AUTO && placing === "text" ? { variable: "client_name" } : {}),
    };
    setFields((prev) => [...prev, f]);
    setSelectedId(f.id);
    if (!e.shiftKey) setPlacing(null);
  };

  const startDrag = (e: React.PointerEvent, f: Field, corner?: [number, number]) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedId(f.id);
    setPlacing(null);
    const overlay = overlays.current.get(f.page);
    if (!overlay) return;
    const rect = overlay.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY };
    const minW = 8 / pages[f.page].width;
    const minH = 8 / pages[f.page].height;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / rect.width;
      const dy = (ev.clientY - start.y) / rect.height;
      let next = { x: f.x, y: f.y, w: f.w, h: f.h };
      if (!corner) next = { ...next, x: f.x + dx, y: f.y + dy };
      else {
        const [cx, cy] = corner;
        if (cx === 1) next.w = Math.max(minW, f.w + dx);
        else {
          next.w = Math.max(minW, f.w - dx);
          next.x = f.x + f.w - next.w;
        }
        if (cy === 1) next.h = Math.max(minH, f.h + dy);
        else {
          next.h = Math.max(minH, f.h - dy);
          next.y = f.y + f.h - next.h;
        }
      }
      const clamped = clampRect(next);
      setFields((prev) => prev.map((p) => (p.id === f.id ? { ...p, ...clamped, source: p.source === "detected" ? "manual" : p.source, confidence: 1 } : p)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, dialog")) return;
      if (e.key === "Escape") {
        setPlacing(null);
        setSelectedId(null);
        return;
      }
      const f = fields.find((x) => x.id === selectedId);
      if (!f) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        remove(f.id);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicate(f);
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 0.01 : 0.002;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        update(f.id, clampRect({ x: f.x + dx, y: f.y + dy, w: f.w, h: f.h }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
     
  }, [fields, selectedId]);

  const roleLabel = (key: string) => (key === AUTO ? "Automatic" : (roles.find((r) => r.key === key)?.label ?? "Removed signer"));
  const variableLabel = (key?: string) => BUILTIN_VARIABLES.find((v) => v.key === key)?.label ?? variables.find((v) => v.key === key)?.label ?? "Choose a value";
  const fieldCaption = (f: Field) => (f.assignee === AUTO && f.type === "text" ? variableLabel(f.variable) : f.type === "text" && f.label ? f.label : TYPE_LABEL[f.type]);

  const addVariable = (label: string): string | null => {
    const clean = label.trim();
    if (!clean) return null;
    let key = slugKey(clean);
    if (BUILTIN_VARIABLES.some((v) => v.key === key)) key = `${key}_custom`;
    if (!variables.some((v) => v.key === key)) setVariables((prev) => [...prev, { key, label: clean, required: true }]);
    return key;
  };

  return (
    <div className="flex h-dvh flex-col bg-paper">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4">
        <Link href="/agreements" aria-label="Back to agreements" className="grid size-9 shrink-0 place-items-center rounded-md text-muted hover:bg-line-2 hover:text-ink">
          <ArrowLeft className="size-4.5" />
        </Link>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          aria-label="Agreement name"
          className="h-9 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-[15px] font-semibold hover:border-line focus:border-blue focus:bg-surface focus:outline-none sm:max-w-sm"
        />
        <div className="flex items-center gap-2 max-sm:hidden">
          {isLive ? <Badge tone="green">Live, version {version}</Badge> : <Badge>Draft</Badge>}
          {isDefault && <Badge tone="blue">Default</Badge>}
        </div>
        <span className="ml-auto text-[13px] text-muted max-md:hidden" aria-live="polite">
          {saveState === "saving" ? "Saving" : saveState === "error" ? "Not saved" : saveState === "dirty" ? (isLive ? "Unsaved changes" : "Saving") : isLive ? "" : "Draft saved"}
        </span>
        <Button onClick={publish} loading={busy === "publish"} disabled={isLive && saveState !== "dirty"} className="max-md:ml-auto">
          {isLive ? "Save changes" : "Publish"}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 max-lg:flex-col">
        {/* Document */}
        <div className={clsx("scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-6 sm:px-8", placing && "cursor-crosshair")}>
          <div className="mx-auto max-w-[820px] space-y-6">
            {detecting && (
              <div className="flex items-center gap-3 rounded-xl border border-blue/20 bg-blue-50 px-4 py-3 text-sm text-blue-dark">
                <Spinner className="size-4 text-blue" /> Reading your agreement and looking for signature lines, dates and blanks
              </div>
            )}
            {detectedCount !== null && !detecting && (
              <div className="flex items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm animate-rise">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-blue" />
                <p className="flex-1 text-ink-2">
                  {detectedCount > 0 ? (
                    <>
                      <strong className="font-semibold text-ink">
                        Found {detectedCount} {detectedCount === 1 ? "field" : "fields"} in this agreement.
                      </strong>{" "}
                      Yellow is for the client to fill, blue is filled automatically. Drag to adjust, or select a field to change it.
                    </>
                  ) : (
                    <>
                      <strong className="font-semibold text-ink">No signature lines were found in this document&apos;s text.</strong> It may be a scan. Add a signature page with one click, or place fields
                      yourself from the panel.
                    </>
                  )}
                </p>
                <button type="button" aria-label="Dismiss" onClick={() => setDetectedCount(null)} className="text-muted hover:text-ink">
                  <X className="size-4" />
                </button>
              </div>
            )}
            {error && <div className="rounded-xl border border-red/30 bg-red-50 p-4 text-sm text-red">The document could not be displayed: {error}</div>}

            {pages.map((size, pageIndex) => (
              <div key={`${sha}-${pageIndex}`}>
                <p className="mb-1.5 text-xs font-semibold text-faint">
                  Page {pageIndex + 1} of {pages.length}
                </p>
                <PdfPage
                  doc={doc}
                  index={pageIndex}
                  size={size}
                  onPointerDown={(e) => place(pageIndex, e)}
                  overlayRef={(el) => {
                    if (el) overlays.current.set(pageIndex, el);
                    else overlays.current.delete(pageIndex);
                  }}
                >
                  {fields
                    .filter((f) => f.page === pageIndex)
                    .map((f) => {
                      const t = tone(f.assignee, roles);
                      const Icon = TYPE_ICON[f.type];
                      const isSelected = f.id === selectedId;
                      const unsure = f.source === "detected" && (f.confidence ?? 1) < 0.6;
                      const hasIssue = errors.some((i) => i.fieldId === f.id);
                      return (
                        <div
                          key={f.id}
                          role="button"
                          tabIndex={0}
                          aria-label={`${fieldCaption(f)} field for ${roleLabel(f.assignee)}`}
                          onPointerDown={(e) => startDrag(e, f)}
                          onFocus={() => setSelectedId(f.id)}
                          style={{ ...fieldBox(f), touchAction: "none" }}
                          className={clsx(
                            "absolute flex cursor-grab items-center gap-[0.5cqw] overflow-visible rounded-[3px] px-[0.5cqw] ring-1 select-none active:cursor-grabbing",
                            t.box,
                            isSelected && "z-10 ring-2 ring-blue",
                            hasIssue && !isSelected && "ring-2 ring-red",
                          )}
                        >
                          {f.type !== "checkbox" && (
                            <>
                              <Icon className="shrink-0" style={{ width: "min(1.6cqh, 80%)", height: "min(1.6cqh, 80%)" }} />
                              <span className="truncate font-semibold" style={{ fontSize: "max(8px, 1.15cqh)" }}>
                                {fieldCaption(f)}
                                {!f.required && " (optional)"}
                              </span>
                            </>
                          )}
                          {unsure && <span className="absolute -top-2 -right-1 rounded-full bg-amber px-1.5 text-[9px] leading-4 font-bold text-white">Check</span>}
                          {isSelected &&
                            ([
                              [0, 0],
                              [1, 0],
                              [0, 1],
                              [1, 1],
                            ] as [number, number][]).map(([cx, cy]) => (
                              <span
                                key={`${cx}${cy}`}
                                onPointerDown={(e) => startDrag(e, f, [cx, cy])}
                                className={clsx("absolute size-2.5 rounded-full border-2 border-blue bg-white", cx === cy ? "cursor-nwse-resize" : "cursor-nesw-resize")}
                                style={{ left: cx ? undefined : -5, right: cx ? -5 : undefined, top: cy ? undefined : -5, bottom: cy ? -5 : undefined }}
                              />
                            ))}
                        </div>
                      );
                    })}
                </PdfPage>
              </div>
            ))}
          </div>
        </div>

        {/* Panel */}
        <aside className="scroll-thin w-full shrink-0 overflow-y-auto border-line bg-surface max-lg:max-h-[46dvh] max-lg:border-t lg:w-[340px] lg:border-l">
          {/* Readiness */}
          <section className="border-b border-line-2 p-4">
            {errors.length === 0 ? (
              <div className="flex items-start gap-2.5 rounded-lg bg-green-50 p-3 text-sm text-green">
                <CircleCheck className="mt-0.5 size-4 shrink-0" />
                <p>
                  <strong className="font-semibold">{isLive ? "This agreement is live." : "Ready to publish."}</strong>{" "}
                  <span className="text-ink-2">{isLive ? "New files are sent this version automatically." : "Once published, every new file is sent this agreement."}</span>
                </p>
              </div>
            ) : (
              <div>
                <h2 className="text-[13px] font-semibold text-ink-2">Before you can publish</h2>
                <ul className="mt-2 space-y-2">
                  {errors.map((issue, i) => (
                    <li key={i} className="rounded-lg border border-red/20 bg-red-50 p-3 text-sm">
                      <p className="flex items-start gap-2 text-ink">
                        <CircleAlert className="mt-0.5 size-4 shrink-0 text-red" />
                        {issue.message}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2 pl-6">
                        {issue.fix === "firm_signature" && (
                          <Button size="sm" onClick={() => setFirmDialog(true)}>
                            Set up firm signature
                          </Button>
                        )}
                        {issue.fix === "add_signature_page" && (
                          <>
                            <Button size="sm" onClick={addSignaturePage} loading={busy === "page"}>
                              <FilePlus2 className="size-3.5" /> Add a signature page
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setAssignee(roles[0]?.key ?? AUTO);
                                setPlacing("signature");
                              }}
                            >
                              Place it myself
                            </Button>
                          </>
                        )}
                        {issue.fieldId && !issue.fix && (
                          <Button size="sm" variant="secondary" onClick={() => setSelectedId(issue.fieldId!)}>
                            Show field
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {issues
              .filter((i) => i.level === "warning")
              .map((issue, i) => (
                <p key={i} className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-[13px] text-ink-2">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber" />
                  {issue.message}
                </p>
              ))}
          </section>

          {/* Selected field */}
          {selected && (
            <section className="border-b border-line-2 p-4 animate-rise">
              <div className="flex items-center justify-between">
                <h2 className="text-[13px] font-semibold text-ink-2">Selected field</h2>
                <div className="flex gap-1">
                  <button type="button" onClick={() => duplicate(selected)} aria-label="Duplicate field" title="Duplicate" className="grid size-8 place-items-center rounded-md text-muted hover:bg-line-2 hover:text-ink">
                    <Copy className="size-4" />
                  </button>
                  <button type="button" onClick={() => remove(selected.id)} aria-label="Delete field" title="Delete" className="grid size-8 place-items-center rounded-md text-muted hover:bg-red-50 hover:text-red">
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <FormField label="Type">
                  <Select value={selected.type} onChange={(e) => update(selected.id, { type: e.target.value as FieldType })}>
                    {(Object.keys(TYPE_LABEL) as FieldType[]).map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABEL[t]}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="Filled by">
                  <Select
                    value={selected.assignee}
                    onChange={(e) => {
                      const next = e.target.value;
                      update(selected.id, { assignee: next, ...(next === AUTO && selected.type === "text" && !selected.variable ? { variable: "client_name" } : {}) });
                    }}
                  >
                    {roles.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.label}
                      </option>
                    ))}
                    <option value={AUTO}>Automatic</option>
                  </Select>
                </FormField>
              </div>

              {selected.assignee === AUTO ? (
                <div className="mt-3 space-y-3">
                  {selected.type === "text" ? (
                    <FormField label="Filled with" hint="Custom values are asked for when a file is opened.">
                      <Select
                        value={selected.variable ?? ""}
                        onChange={(e) => {
                          if (e.target.value === "__new") {
                            const label = window.prompt("Name this value (for example: Fee percentage)");
                            const key = label ? addVariable(label) : null;
                            if (key) update(selected.id, { variable: key });
                          } else update(selected.id, { variable: e.target.value });
                        }}
                      >
                        {!selected.variable && <option value="">Choose a value</option>}
                        <optgroup label="From the file">
                          {BUILTIN_VARIABLES.map((v) => (
                            <option key={v.key} value={v.key}>
                              {v.label}
                            </option>
                          ))}
                        </optgroup>
                        {variables.length > 0 && (
                          <optgroup label="Custom values">
                            {variables.map((v) => (
                              <option key={v.key} value={v.key}>
                                {v.label}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        <option value="__new">New custom value...</option>
                      </Select>
                    </FormField>
                  ) : (
                    <p className="rounded-lg bg-blue-50 p-3 text-[13px] text-ink-2">
                      {selected.type === "signature" || selected.type === "initials"
                        ? "Your firm signature is applied here when the agreement is sent."
                        : selected.type === "date"
                          ? "Filled with the date the agreement is sent."
                          : selected.type === "name"
                            ? "Filled with your firm signer's name."
                            : "Ticked automatically."}
                    </p>
                  )}
                  {selected.type === "text" && (
                    <label className="flex items-center gap-2.5 text-sm text-ink-2">
                      <input type="checkbox" checked={Boolean(selected.mask)} onChange={(e) => update(selected.id, { mask: e.target.checked })} className="size-4 accent-[var(--color-blue)]" />
                      Cover the text underneath (for placeholders)
                    </label>
                  )}
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  {selected.type === "text" && (
                    <FormField label="Label shown to the signer">
                      <Input value={selected.label ?? ""} onChange={(e) => update(selected.id, { label: e.target.value })} maxLength={60} placeholder="For example: Mailing address" />
                    </FormField>
                  )}
                  {selected.type === "date" ? (
                    <p className="rounded-lg bg-paper p-3 text-[13px] text-ink-2">Filled with the date the signer signs. Signers cannot change it.</p>
                  ) : (
                    <label className="flex items-center gap-2.5 text-sm text-ink-2">
                      <input type="checkbox" checked={selected.required} onChange={(e) => update(selected.id, { required: e.target.checked })} className="size-4 accent-[var(--color-blue)]" />
                      Required to finish signing
                    </label>
                  )}
                </div>
              )}
              <p className="mt-3 text-xs text-faint">Drag to move, drag a corner to resize. Arrow keys nudge, Delete removes.</p>
            </section>
          )}

          {/* Add fields */}
          <section className="border-b border-line-2 p-4">
            <h2 className="text-[13px] font-semibold text-ink-2">Add a field</h2>
            <div className="mt-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Who fills the field">
              {[...roles.map((r) => ({ key: r.key, label: r.label })), { key: AUTO, label: "Automatic" }].map((r) => (
                <button
                  key={r.key}
                  type="button"
                  role="radio"
                  aria-checked={assignee === r.key}
                  onClick={() => setAssignee(r.key)}
                  className={clsx(
                    "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition-colors",
                    assignee === r.key ? "border-ink bg-ink text-white" : "border-line text-ink-2 hover:border-faint",
                  )}
                >
                  <span className={clsx("size-2 rounded-full", tone(r.key, roles).dot)} />
                  {r.label}
                </button>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-1.5">
              {(Object.keys(TYPE_LABEL) as FieldType[]).map((t) => {
                const Icon = TYPE_ICON[t];
                return (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={placing === t}
                    onClick={() => setPlacing(placing === t ? null : t)}
                    className={clsx(
                      "flex h-16 flex-col items-center justify-center gap-1.5 rounded-lg border text-xs font-semibold transition-colors",
                      placing === t ? "border-blue bg-blue-50 text-blue" : "border-line text-ink-2 hover:border-faint hover:bg-paper",
                    )}
                  >
                    <Icon className="size-4" />
                    {TYPE_LABEL[t]}
                  </button>
                );
              })}
            </div>
            <p className="mt-2.5 text-[13px] text-muted">
              {placing ? (
                <span className="font-semibold text-blue">Now click the page where the {TYPE_LABEL[placing].toLowerCase()} goes. Esc cancels.</span>
              ) : assignee === AUTO ? (
                "Automatic fields are filled by Onfile when a file is opened: your firm signature, dates, the client's name."
              ) : (
                "Choose a field, then click the page where it belongs."
              )}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={addSignaturePage} loading={busy === "page"}>
                <FilePlus2 className="size-3.5" /> Add signature page
              </Button>
              <Button size="sm" variant="secondary" onClick={() => runDetection(true)} disabled={detecting || !doc}>
                <ScanSearch className="size-3.5" /> Detect again
              </Button>
            </div>
          </section>

          {/* Signers */}
          <section className="border-b border-line-2 p-4">
            <h2 className="text-[13px] font-semibold text-ink-2">Who signs</h2>
            <ul className="mt-2 space-y-2">
              {roles.map((r, i) => (
                <li key={r.key} className="flex items-center gap-2">
                  <span className={clsx("size-2.5 shrink-0 rounded-full", tone(r.key, roles).dot)} />
                  <Input value={r.label} onChange={(e) => setRoles((prev) => prev.map((x) => (x.key === r.key ? { ...x, label: e.target.value.slice(0, 40) } : x)))} aria-label={`Signer ${i + 1} label`} className="h-9" />
                  {i > 0 && (
                    <button
                      type="button"
                      aria-label={`Remove ${r.label}`}
                      onClick={() => {
                        setRoles((prev) => prev.filter((x) => x.key !== r.key));
                        setFields((prev) => prev.filter((f) => f.assignee !== r.key));
                        if (assignee === r.key) setAssignee(roles[0].key);
                      }}
                      className="grid size-9 shrink-0 place-items-center rounded-md text-muted hover:bg-red-50 hover:text-red"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </li>
              ))}
              <li className="flex items-center gap-2 text-sm text-ink-2">
                <span className="size-2.5 shrink-0 rounded-full bg-blue" />
                <span className="flex-1">{firmSigner ? `${firmName}: ${firmSigner.name}` : `${firmName} (automatic)`}</span>
                <Button size="sm" variant="ghost" onClick={() => setFirmDialog(true)}>
                  {firmSigner ? "Change" : "Set up"}
                </Button>
              </li>
            </ul>
            {roles.length < 3 && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                onClick={() => {
                  const key = ["client2", "client3"].find((k) => !roles.some((r) => r.key === k)) ?? `signer${roles.length + 1}`;
                  setRoles((prev) => [...prev, { key, label: "Co-signer" }]);
                  setAssignee(key);
                }}
              >
                <Plus className="size-3.5" /> Add another signer
              </Button>
            )}
          </section>

          {/* Custom values */}
          {variables.length > 0 && (
            <section className="border-b border-line-2 p-4">
              <h2 className="text-[13px] font-semibold text-ink-2">Custom values</h2>
              <p className="mt-1 text-[13px] text-muted">Asked for each time a file is opened, then printed on the agreement.</p>
              <ul className="mt-2 space-y-2">
                {variables.map((v) => {
                  const used = fields.some((f) => f.variable === v.key);
                  return (
                    <li key={v.key} className="flex items-center gap-2">
                      <Input value={v.label} onChange={(e) => setVariables((prev) => prev.map((x) => (x.key === v.key ? { ...x, label: e.target.value.slice(0, 60) } : x)))} aria-label="Value name" className="h-9" />
                      {used ? (
                        <Badge tone="blue">In use</Badge>
                      ) : (
                        <button type="button" aria-label={`Remove ${v.label}`} onClick={() => setVariables((prev) => prev.filter((x) => x.key !== v.key))} className="grid size-9 shrink-0 place-items-center rounded-md text-muted hover:bg-red-50 hover:text-red">
                          <Trash2 className="size-4" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* Email */}
          <section className="p-4">
            <details>
              <summary className="text-[13px] font-semibold text-ink-2">Email sent with this agreement</summary>
              <div className="mt-3 space-y-3">
                <FormField label="Subject" optional>
                  <Input value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} maxLength={140} placeholder={`${firmName} needs your signature`} />
                </FormField>
                <FormField label="Personal note" optional hint="Shown above the button in the email.">
                  <Textarea value={emailMessage} onChange={(e) => setEmailMessage(e.target.value)} maxLength={1200} placeholder="Thank you for choosing us. Please sign so we can get started." />
                </FormField>
              </div>
            </details>
          </section>
        </aside>
      </div>

      <FirmSignerDialog open={firmDialog} onClose={() => setFirmDialog(false)} current={firmSigner} firmName={firmName} onSaved={setFirmSigner} />

      <Dialog
        open={published}
        onClose={() => setPublished(false)}
        size="sm"
        title="Published"
        description="From now on, opening a file sends this agreement to the client automatically. Reminders follow until it is signed."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPublished(false)}>
              Keep editing
            </Button>
            <LinkButton href="/files/new">
              <Check className="size-4" /> Open your first file
            </LinkButton>
          </>
        }
      />
    </div>
  );
}
