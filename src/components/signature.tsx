"use client";

import clsx from "clsx";
import { Eraser, PenLine, Type } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SIGNATURE_FACES } from "@/lib/fonts";
import { inkLength, normalizeStrokes, strokesToPath } from "@/lib/signature";
import type { SignatureValue } from "@/lib/types";
import { Button, Dialog, Input, Segmented } from "./ui";

const INK = "#121c33";

/** Render a stored signature. Drawn ones are vector paths, typed ones are images. */
export function SignatureView({ value, className, align = "left" }: { value: SignatureValue; className?: string; align?: "left" | "center" }) {
  if (value.kind === "typed") {
     
    return <img src={value.dataUrl} alt={`Signature: ${value.text}`} className={clsx("size-full object-contain", align === "left" ? "object-left-bottom" : "object-center", className)} draggable={false} />;
  }
  return (
    <svg
      viewBox={`0 0 ${value.width} ${value.height}`}
      preserveAspectRatio={align === "left" ? "xMinYMax meet" : "xMidYMid meet"}
      className={clsx("size-full overflow-visible", className)}
      role="img"
      aria-label="Signature"
    >
      <path d={strokesToPath(value.strokes)} fill="none" stroke={INK} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function DrawPad({ onChange, height = 190 }: { onChange: (strokes: number[][]) => void; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<number[][]>([]);
  const active = useRef<number[] | null>(null);
  const [empty, setEmpty] = useState(true);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke(new Path2D(strokesToPath(strokes.current)));
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      paint();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [paint]);

  const point = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return [Math.round((e.clientX - rect.left) * 10) / 10, Math.round((e.clientY - rect.top) * 10) / 10];
  };

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        style={{ height, touchAction: "none" }}
        className="block w-full cursor-crosshair rounded-xl border border-line bg-[#fcfdfe]"
        aria-label="Signature drawing area"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          active.current = point(e);
          strokes.current = [...strokes.current, active.current];
          setEmpty(false);
          paint();
        }}
        onPointerMove={(e) => {
          if (!active.current) return;
          // Coalesced events keep fast strokes smooth on high refresh rate screens.
          const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
          const rect = canvasRef.current!.getBoundingClientRect();
          for (const ev of events) {
            const x = Math.round((ev.clientX - rect.left) * 10) / 10;
            const y = Math.round((ev.clientY - rect.top) * 10) / 10;
            const n = active.current.length;
            if (Math.hypot(x - active.current[n - 2], y - active.current[n - 1]) >= 1.2) active.current.push(x, y);
          }
          paint();
        }}
        onPointerUp={() => {
          active.current = null;
          onChange(strokes.current);
        }}
        onPointerCancel={() => {
          active.current = null;
          onChange(strokes.current);
        }}
      />
      <div className="pointer-events-none absolute inset-x-6 bottom-12 flex items-end gap-2 border-b border-dashed border-faint/60 pb-1 text-faint" aria-hidden>
        <span className="text-lg leading-none">x</span>
      </div>
      {empty && <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-8 text-center text-sm text-faint">Draw with your finger, mouse or stylus</p>}
      <button
        type="button"
        className="absolute right-2 bottom-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-semibold text-muted hover:bg-line-2 hover:text-ink disabled:opacity-0"
        disabled={empty}
        onClick={() => {
          strokes.current = [];
          setEmpty(true);
          paint();
          onChange([]);
        }}
      >
        <Eraser className="size-3.5" /> Clear
      </button>
    </div>
  );
}

async function renderTyped(text: string, family: string, scale: number): Promise<SignatureValue> {
  const size = 96 * scale;
  await document.fonts.load(`${size}px ${family}`, text).catch(() => {});
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = `${size}px ${family}`;
  const m = probe.measureText(text);
  const ascent = Math.max(m.actualBoundingBoxAscent, size * 0.7);
  const descent = Math.max(m.actualBoundingBoxDescent, size * 0.25);
  const pad = 14;
  const width = Math.ceil(m.width + (m.actualBoundingBoxLeft || 0) + pad * 2 + size * 0.2);
  const height = Math.ceil(ascent + descent + pad * 2);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${size}px ${family}`;
  ctx.fillStyle = INK;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, pad + (m.actualBoundingBoxLeft || 0), pad + ascent);
  return { kind: "typed", text, dataUrl: canvas.toDataURL("image/png"), width, height };
}

/**
 * Adopt a signature: draw it, or type it and pick a hand. Works the same for initials.
 */
export function SignatureDialog({
  open,
  onClose,
  onAdopt,
  name,
  mode = "signature",
  confirmLabel,
}: {
  open: boolean;
  onClose: () => void;
  onAdopt: (value: SignatureValue) => void;
  name: string;
  mode?: "signature" | "initials";
  confirmLabel?: string;
}) {
  const initialText = mode === "initials" ? name.split(/\s+/).map((p) => p[0]?.toUpperCase() ?? "").join("") : name;
  const [tab, setTab] = useState<"draw" | "type">("draw");
  const [strokes, setStrokes] = useState<number[][]>([]);
  const [text, setText] = useState(initialText);
  const [face, setFace] = useState(SIGNATURE_FACES[0].id);
  const [busy, setBusy] = useState(false);
  const [padKey, setPadKey] = useState(0);

  useEffect(() => {
    if (open) {
      setStrokes([]);
      setText(initialText);
      setPadKey((k) => k + 1);
    }
  }, [open, initialText]);

  const drawnOk = inkLength(strokes) > 24;
  const ready = tab === "draw" ? drawnOk : text.trim().length > 0;

  const adopt = async () => {
    setBusy(true);
    try {
      if (tab === "draw") onAdopt({ kind: "drawn", ...normalizeStrokes(strokes) });
      else {
        const f = SIGNATURE_FACES.find((x) => x.id === face)!;
        onAdopt(await renderTyped(text.trim(), f.family, f.scale));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={mode === "initials" ? "Add your initials" : "Add your signature"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={adopt} disabled={!ready} loading={busy}>
            {confirmLabel ?? "Use this signature"}
          </Button>
        </>
      }
    >
      <Segmented
        value={tab}
        onChange={setTab}
        className="mb-4"
        options={[
          { value: "draw", label: (<span className="inline-flex items-center gap-1.5"><PenLine className="size-3.5" /> Draw</span>) },
          { value: "type", label: (<span className="inline-flex items-center gap-1.5"><Type className="size-3.5" /> Type</span>) },
        ]}
      />
      {tab === "draw" ? (
        <DrawPad key={padKey} onChange={setStrokes} height={mode === "initials" ? 150 : 190} />
      ) : (
        <div className="space-y-3">
          <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={mode === "initials" ? 6 : 80} placeholder={mode === "initials" ? "Your initials" : "Your full name"} autoFocus aria-label="Name to sign with" />
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Signature style">
            {SIGNATURE_FACES.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={face === f.id}
                onClick={() => setFace(f.id)}
                className={clsx(
                  "flex h-24 flex-col items-center justify-center overflow-hidden rounded-xl border px-3 transition-colors",
                  face === f.id ? "border-blue bg-blue-50 ring-2 ring-blue/20" : "border-line bg-surface hover:border-faint",
                )}
              >
                <span className={clsx(f.className, "block max-w-full truncate leading-none text-[#121c33]")} style={{ fontSize: 30 * f.scale }}>
                  {text.trim() || (mode === "initials" ? "AB" : "Your name")}
                </span>
                <span className="mt-2 text-[11px] font-semibold text-muted">{f.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="mt-3 text-xs leading-relaxed text-muted">
        By choosing {confirmLabel ?? "Use this signature"}, you agree this is your electronic {mode === "initials" ? "initials" : "signature"}, as valid as a handwritten one.
      </p>
    </Dialog>
  );
}
