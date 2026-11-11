"use client";

import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { extractPdf } from "@/lib/extract";
import type { PageSize } from "@/lib/types";

type Pdfjs = typeof import("pdfjs-dist");
export type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;

let pdfjsPromise: Promise<Pdfjs> | null = null;

/**
 * pdf.js is loaded on demand, and from its "legacy" build: signers open links on whatever
 * phone they own, and the modern build fails on browsers only a couple of years old.
 */
export function loadPdfjs(): Promise<Pdfjs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<Pdfjs>).then((m) => {
      m.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      return m;
    });
  }
  return pdfjsPromise;
}

export function usePdf(url: string | null) {
  const [state, setState] = useState<{ doc: PdfDoc | null; error: string | null; url: string | null }>({ doc: null, error: null, url: null });
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let task: ReturnType<Pdfjs["getDocument"]> | null = null;
    loadPdfjs()
      .then((pdfjs) => {
        if (cancelled) return;
        task = pdfjs.getDocument({ url, withCredentials: true });
        return task.promise;
      })
      .then((doc) => {
        if (doc && !cancelled) setState({ doc, error: null, url });
      })
      .catch((err) => {
        if (!cancelled) setState({ doc: null, error: err?.message ?? "The document could not be loaded.", url });
      });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [url]);
  const current = state.url === url;
  return { doc: current ? state.doc : null, error: current ? state.error : null, loading: !current || (!state.doc && !state.error) };
}

const MAX_PIXELS = 7_000_000; // stay inside mobile Safari's canvas budget

/**
 * One page: a canvas that renders when scrolled near, with an overlay layer on top.
 * The wrapper is a CSS size container, so overlays position with percentages and size
 * text with cqh units, and stay glued to the page at any width with no resize math.
 */
export function PdfPage({
  doc,
  index,
  size,
  children,
  className,
  onPointerDown,
  overlayRef,
}: {
  doc: PdfDoc | null;
  index: number;
  size: PageSize;
  children?: ReactNode;
  className?: string;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  overlayRef?: (el: HTMLDivElement | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(index < 2);
  const [width, setWidth] = useState(0);
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => entry.isIntersecting && setNear(true), { rootMargin: "900px 0px" });
    io.observe(el);
    let frame = 0;
    const ro = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const w = Math.round(entry.contentRect.width);
        // Re-render only on meaningful width changes; CSS scales the bitmap in between.
        setWidth((prev) => (Math.abs(prev - w) > Math.max(24, prev * 0.08) ? w : prev));
      });
    });
    ro.observe(el);
    return () => {
      io.disconnect();
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!doc || !near || !width) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    (async () => {
      const page = await doc.getPage(index + 1);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      let scale = (width * Math.min(window.devicePixelRatio || 1, 2.5)) / base.width;
      const pixels = base.width * scale * base.height * scale;
      if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
      const viewport = page.getViewport({ scale });
      // Render off screen, then swap, so a re-render never flashes a blank page.
      const buffer = document.createElement("canvas");
      buffer.width = Math.floor(viewport.width);
      buffer.height = Math.floor(viewport.height);
      task = page.render({ canvas: buffer, canvasContext: buffer.getContext("2d")!, viewport } as Parameters<typeof page.render>[0]);
      await task.promise;
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      canvas.width = buffer.width;
      canvas.height = buffer.height;
      canvas.getContext("2d")!.drawImage(buffer, 0, 0);
      setPainted(true);
    })().catch(() => {});
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, index, near, width]);

  return (
    <div
      ref={wrapRef}
      className={clsx("sheet relative w-full overflow-hidden", className)}
      style={{ aspectRatio: `${size.width} / ${size.height}`, containerType: "size" }}
      data-page={index}
    >
      <canvas ref={canvasRef} className={clsx("absolute inset-0 size-full transition-opacity duration-300", painted ? "opacity-100" : "opacity-0")} aria-label={`Page ${index + 1}`} />
      {!painted && (
        <div className="absolute inset-0 grid place-items-center" aria-hidden>
          <div className="w-2/3 space-y-[3cqh]">
            {[90, 100, 96, 70, 100, 88, 94, 40].map((w, i) => (
              <div key={i} className="h-[1.1cqh] animate-pulse rounded-full bg-line-2" style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
      )}
      <div ref={overlayRef} className="absolute inset-0" onPointerDown={onPointerDown}>
        {children}
      </div>
    </div>
  );
}

/** Pull positioned text and form widgets out of a PDF for field detection. */
export async function extractForDetection(doc: PdfDoc) {
  const pdfjs = await loadPdfjs();
  return extractPdf(doc, pdfjs.Util.transform);
}

/**
 * Last-resort repair for PDFs the server cannot stamp (encrypted or malformed): render
 * every page in the browser and rebuild a clean PDF from the images.
 */
export async function rasterizeToPdf(file: Blob, onProgress?: (done: number, total: number) => void): Promise<Uint8Array> {
  const pdfjs = await loadPdfjs();
  const { PDFDocument } = await import("pdf-lib");
  const src = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out = await PDFDocument.create();
  for (let i = 1; i <= src.numPages; i++) {
    const page = await src.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 1700 / base.width) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport } as Parameters<typeof page.render>[0]).promise;
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.86));
    const image = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    out.addPage([base.width, base.height]).drawImage(image, { x: 0, y: 0, width: base.width, height: base.height });
    onProgress?.(i, src.numPages);
  }
  await src.destroy();
  return out.save();
}
