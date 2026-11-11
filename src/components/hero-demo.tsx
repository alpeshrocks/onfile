"use client";

import clsx from "clsx";
import { PenLine, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { inkLength, strokesToPath } from "@/lib/signature";

/**
 * The landing page's one interactive moment: sign the sheet, watch the file clear.
 * It is the product's whole promise at the size of a postcard.
 */
export function HeroDemo() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<number[][]>([]);
  const active = useRef<number[] | null>(null);
  const [touched, setTouched] = useState(false);
  const [signed, setSigned] = useState(false);
  const [steps, setSteps] = useState(0);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#121c33";
    ctx.lineWidth = 2.2;
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

  useEffect(() => {
    if (!signed) return;
    const timers = [1, 2, 3].map((n) => setTimeout(() => setSteps(n), n * 420));
    return () => timers.forEach(clearTimeout);
  }, [signed]);

  const point = (e: React.PointerEvent | PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const reset = () => {
    strokes.current = [];
    setTouched(false);
    setSigned(false);
    setSteps(0);
    paint();
  };

  return (
    <div className="relative mx-auto w-full max-w-[460px]">
      {/* The file */}
      <span className="folder-tab">
        <span className="mono">F-0142</span>
      </span>
      <div className="rounded-xl rounded-tl-none border border-line bg-surface p-4 shadow-lift">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[15px] font-semibold">Jordan Avery</p>
            <p className="text-[13px] text-muted">Kitchen water damage</p>
          </div>
          <span
            className={clsx(
              "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors duration-500",
              signed ? "bg-green-50 text-green" : "bg-flag-50 text-flag-ink",
            )}
            aria-live="polite"
          >
            <span className={clsx("size-1.5 rounded-full transition-colors duration-500", signed ? "bg-green" : "bg-flag-ink/70")} />
            {signed ? "Signed, cleared to start" : "Awaiting signature"}
          </span>
        </div>

        {/* The agreement */}
        <div className="sheet mt-4 rounded-sm px-6 pt-6 pb-5">
          <p className="display text-[17px]">Client Services Agreement</p>
          <div className="mt-3 space-y-2" aria-hidden>
            {[100, 94, 98, 62].map((w, i) => (
              <div key={i} className="h-[5px] rounded-full bg-line-2" style={{ width: `${w}%` }} />
            ))}
          </div>
          <div className="mt-3 space-y-2" aria-hidden>
            {[96, 100, 40].map((w, i) => (
              <div key={i} className="h-[5px] rounded-full bg-line-2" style={{ width: `${w}%` }} />
            ))}
          </div>

          <div className="relative mt-5">
            <canvas
              ref={canvasRef}
              aria-label="Try it: draw a signature here"
              style={{ touchAction: "none" }}
              className={clsx("block h-[84px] w-full rounded-[4px] transition-colors duration-300", signed ? "bg-transparent" : touched ? "cursor-crosshair bg-flag/25" : "cursor-crosshair bg-flag/80")}
              onPointerDown={(e) => {
                if (signed) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                active.current = point(e);
                strokes.current = [...strokes.current, active.current];
                setTouched(true);
              }}
              onPointerMove={(e) => {
                if (!active.current) return;
                const [x, y] = point(e);
                active.current.push(x, y);
                paint();
              }}
              onPointerUp={() => {
                active.current = null;
                if (inkLength(strokes.current) > 90) setSigned(true);
              }}
            />
            {!touched && (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm font-semibold text-flag-ink">
                <PenLine className="size-4" /> Sign here to try it
              </span>
            )}
            <div className="mt-0 border-t border-ink" />
            <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
              <span>Client signature</span>
              {touched && (
                <button type="button" onClick={reset} className="inline-flex items-center gap-1 font-semibold text-blue hover:underline">
                  <RotateCcw className="size-3" /> Start over
                </button>
              )}
            </div>
          </div>
        </div>

        {/* What happens next, without anyone doing anything */}
        <ol className="mt-4 space-y-2 text-[13px]">
          {["Signed PDF and certificate filed on F-0142", "Signed copy emailed to Jordan", "Your case system notified: cleared to start"].map((label, i) => (
            <li key={label} className={clsx("flex items-center gap-2.5 transition-[opacity,transform] duration-500", steps > i ? "translate-y-0 opacity-100" : "translate-y-1 opacity-35")}>
              <span className={clsx("grid size-4 shrink-0 place-items-center rounded-full transition-colors duration-500", steps > i ? "bg-green" : "bg-line")}>
                <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden>
                  <path d="M2.5 6.2l2.3 2.3L9.5 3.8" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className={steps > i ? "text-ink" : "text-muted"}>{label}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
