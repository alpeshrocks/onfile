import type { FormWidget, PageText, TextItem } from "./detect";

/**
 * Turn a pdf.js document into the positioned text and form widgets that field detection
 * reads. Kept free of browser APIs (it takes pdf.js's matrix helper as an argument) so the
 * exact code that runs in the editor is also exercised against real PDFs in the test suite.
 */

type Matrix = number[];

interface PdfPageLike {
  getViewport(opts: { scale: number }): { width: number; height: number; transform: Matrix; convertToViewportRectangle(rect: number[]): number[] };
  getTextContent(): Promise<{ items: unknown[] }>;
  getAnnotations(): Promise<unknown[]>;
}
interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
}

export async function extractPdf(doc: PdfDocLike, transform: (a: Matrix, b: Matrix) => Matrix): Promise<{ pages: PageText[]; widgets: FormWidget[] }> {
  const pages: PageText[] = [];
  const widgets: FormWidget[] = [];
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    const viewport = page.getViewport({ scale: 1 });
    const W = viewport.width;
    const H = viewport.height;
    const items: TextItem[] = [];
    try {
      const content = await page.getTextContent();
      for (const raw of content.items) {
        const item = raw as { str?: string; transform?: number[]; width?: number };
        if (!item.str || !item.transform) continue;
        // Compose the glyph matrix with the viewport so rotation and crop are already applied.
        const tx = transform(viewport.transform, item.transform);
        if (Math.abs(tx[1]) > Math.abs(tx[0])) continue; // text running vertically on screen
        const fontHeight = Math.hypot(tx[2], tx[3]);
        if (!(fontHeight > 0)) continue;
        items.push({ str: item.str, x: tx[4] / W, y: (tx[5] - fontHeight) / H, w: (item.width ?? 0) / W, h: fontHeight / H });
      }
    } catch {
      // A page whose text cannot be read simply contributes no proposals.
    }
    pages.push({ page: i, width: W, height: H, items });

    try {
      const annotations = (await page.getAnnotations()) as { subtype?: string; rect?: number[]; fieldType?: string; fieldName?: string; checkBox?: boolean; hidden?: boolean }[];
      for (const a of annotations) {
        if (a.subtype !== "Widget" || !a.rect || a.hidden) continue;
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect);
        const kind = a.fieldType === "Sig" ? "signature" : a.fieldType === "Tx" ? "text" : a.fieldType === "Btn" && a.checkBox ? "checkbox" : null;
        if (!kind) continue;
        widgets.push({ page: i, x: Math.min(x1, x2) / W, y: Math.min(y1, y2) / H, w: Math.abs(x2 - x1) / W, h: Math.abs(y2 - y1) / H, kind, name: a.fieldName ?? "" });
      }
    } catch {
      // No readable form layer.
    }
  }
  return { pages, widgets };
}
