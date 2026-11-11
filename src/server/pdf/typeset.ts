import { PDFDocument, PDFFont, rgb } from "pdf-lib";
import { AUTO, type Field, type PageSize, type Role } from "@/lib/types";
import { Fonts, cleanText } from "./fonts";

/**
 * Not every agreement arrives as a PDF. Word documents, plain text and photos or scans
 * are converted here so the rest of the system only ever deals with PDFs. PDFs themselves
 * are never re-typeset: they are kept byte for byte.
 */

const W = 612;
const H = 792;
const M = 72;
const INK = rgb(0.08, 0.1, 0.14);
const MUTED = rgb(0.4, 0.43, 0.48);

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
}
export interface Block {
  kind: "h1" | "h2" | "h3" | "p" | "li";
  runs: Run[];
  level?: number;
  marker?: string;
}

const STYLE = {
  h1: { size: 16, before: 6, after: 10, bold: true },
  h2: { size: 12.5, before: 12, after: 5, bold: true },
  h3: { size: 11, before: 9, after: 4, bold: true },
  p: { size: 10.5, before: 0, after: 7, bold: false },
  li: { size: 10.5, before: 0, after: 4, bold: false },
} as const;

export function textToBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", runs: [{ text: para.join("\n") }] });
    para = [];
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\t/g, "    ").trimEnd();
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (!line.trim()) flush();
    else if (heading) {
      flush();
      blocks.push({ kind: `h${heading[1].length}` as "h1", runs: [{ text: heading[2] }] });
    } else if (bullet) {
      flush();
      blocks.push({ kind: "li", runs: [{ text: bullet[1] }], level: 0, marker: "•" });
    } else para.push(line);
  }
  flush();
  return blocks;
}

export async function docxToBlocks(bytes: Uint8Array): Promise<Block[]> {
  const mammoth = (await import("mammoth")).default;
  const { parse } = await import("node-html-parser");
  const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  const root = parse(html);
  const blocks: Block[] = [];

  const inline = (node: any, style: { bold?: boolean; italic?: boolean }, out: Run[]) => {
    for (const child of node.childNodes as any[]) {
      if (child.nodeType === 3) {
        const text = child.text as string;
        if (text) out.push({ text, ...style });
      } else if (child.nodeType === 1) {
        const tag = (child.rawTagName ?? "").toLowerCase();
        if (tag === "br") out.push({ text: "\n" });
        else if (tag === "strong" || tag === "b") inline(child, { ...style, bold: true }, out);
        else if (tag === "em" || tag === "i") inline(child, { ...style, italic: true }, out);
        else if (tag !== "ul" && tag !== "ol") inline(child, style, out);
      }
    }
    return out;
  };

  const walk = (node: any, level: number) => {
    for (const child of node.childNodes as any[]) {
      if (child.nodeType !== 1) continue;
      const tag = (child.rawTagName ?? "").toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const n = Math.min(3, Number(tag[1]));
        blocks.push({ kind: `h${n}` as "h1", runs: inline(child, {}, []) });
      } else if (tag === "p") {
        const runs = inline(child, {}, []);
        if (runs.some((r) => r.text.trim())) blocks.push({ kind: "p", runs });
      } else if (tag === "ul" || tag === "ol") {
        let n = 0;
        for (const li of child.childNodes as any[]) {
          if (li.nodeType !== 1 || (li.rawTagName ?? "").toLowerCase() !== "li") continue;
          n++;
          const runs = inline(li, {}, []);
          if (runs.some((r) => r.text.trim())) blocks.push({ kind: "li", runs, level, marker: tag === "ol" ? `${n}.` : "•" });
          walk(li, level + 1);
        }
      } else if (tag === "table") {
        for (const tr of child.querySelectorAll("tr") as any[]) {
          const cells = (tr.querySelectorAll("td,th") as any[]).map((c) => (c.text as string).replace(/\s+/g, " ").trim());
          if (cells.some(Boolean)) blocks.push({ kind: "p", runs: [{ text: cells.join("     ") }] });
        }
      } else walk(child, level);
    }
  };
  walk(root, 0);
  if (!blocks.length) throw new Error("The Word document appears to be empty.");
  return blocks;
}

interface Piece {
  text: string;
  font: PDFFont;
  width: number;
}

export async function typesetBlocks(blocks: Block[], opts: { title?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts = new Fonts(doc);
  const texts = blocks.flatMap((b) => b.runs.map((r) => r.text));
  const unicode = !(await fonts.allStandard("serif", [...texts, "•"]));
  const face = async (bold?: boolean, italic?: boolean) => {
    const f = bold ? "serifBold" : italic ? "serifItalic" : "serif";
    return (await fonts.pick(f, "", unicode)).font;
  };
  const regular = await face();
  const safe = (font: PDFFont, text: string) => {
    if (!unicode) return text;
    const set = new Set(font.getCharacterSet());
    return [...text].map((c) => (set.has(c.codePointAt(0)!) ? c : "?")).join("");
  };

  let page = doc.addPage([W, H]);
  let y = M;
  const newPage = () => {
    page = doc.addPage([W, H]);
    y = M;
  };

  for (const block of blocks) {
    const style = STYLE[block.kind];
    const size = style.size;
    const lineHeight = size * 1.42;
    const indent = block.kind === "li" ? 18 * ((block.level ?? 0) + 1) : 0;
    const maxWidth = W - M * 2 - indent;

    // Break runs into words, keeping hard line breaks.
    const lines: Piece[][] = [[]];
    let lineWidth = 0;
    for (const run of block.runs) {
      const font = await face(style.bold || run.bold, run.italic);
      const parts = run.text.split(/(\n)/);
      for (const part of parts) {
        if (part === "\n") {
          lines.push([]);
          lineWidth = 0;
          continue;
        }
        for (const token of cleanText(part).split(/( +)/)) {
          if (!token) continue;
          const text = safe(font, token);
          let width = font.widthOfTextAtSize(text, size);
          const isSpace = /^ +$/.test(token);
          if (lineWidth + width > maxWidth && !isSpace && lineWidth > 0) {
            lines.push([]);
            lineWidth = 0;
          }
          if (isSpace && lineWidth === 0 && lines[lines.length - 1].length === 0 && lines.length > 1) continue;
          if (width > maxWidth) {
            // A single unbroken run wider than the column (long blank line): trim to fit.
            let t = text;
            while (t.length > 1 && font.widthOfTextAtSize(t, size) > maxWidth - lineWidth) t = t.slice(0, -1);
            width = font.widthOfTextAtSize(t, size);
            lines[lines.length - 1].push({ text: t, font, width });
            lineWidth += width;
            continue;
          }
          lines[lines.length - 1].push({ text, font, width });
          lineWidth += width;
        }
      }
    }

    y += style.before;
    // Keep a heading with the paragraph after it.
    const needed = block.kind.startsWith("h") ? lineHeight * 3 : lineHeight;
    if (y + needed > H - M) newPage();
    lines.forEach((line, i) => {
      if (y + lineHeight > H - M) newPage();
      const baseline = H - y - size;
      if (i === 0 && block.kind === "li" && block.marker) {
        page.drawText(safe(regular, block.marker), { x: M + indent - 13, y: baseline, size, font: regular, color: INK });
      }
      let x = M + indent;
      for (const piece of line) {
        if (piece.text.trim()) page.drawText(piece.text, { x, y: baseline, size, font: piece.font, color: INK });
        x += piece.width;
      }
      y += lineHeight;
    });
    y += style.after;
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, { x: (W - regular.widthOfTextAtSize(label, 8.5)) / 2, y: 40, size: 8.5, font: regular, color: MUTED });
  });
  if (opts.title) doc.setTitle(opts.title);
  doc.setProducer("Onfile");
  return doc.save();
}

/** One page per image, sized to the image, for photographed or scanned agreements. */
export async function imagesToPdf(images: { bytes: Uint8Array; type: string }[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const img of images) {
    const embedded = img.type === "image/png" ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
    const scale = W / embedded.width;
    const height = Math.min(embedded.height * scale, W * 2.2);
    const page = doc.addPage([W, height]);
    page.drawImage(embedded, { x: 0, y: 0, width: W, height });
  }
  doc.setProducer("Onfile");
  return doc.save();
}

/**
 * Append a signature page for agreements that have no signature lines (or scans where
 * none can be detected). Because Onfile draws the page, it knows exactly where every
 * field is, so the template is ready to use with zero manual placement.
 */
export async function appendSignaturePage(
  source: Uint8Array,
  opts: { roles: Role[]; firmName: string; includeFirm: boolean },
): Promise<{ bytes: Uint8Array; pageIndex: number; page: PageSize; fields: Field[] }> {
  const doc = await PDFDocument.load(source, { updateMetadata: false });
  const fonts = new Fonts(doc);
  const pageIndex = doc.getPageCount();
  const page = doc.addPage([W, H]);
  const fields: Field[] = [];
  const draw = async (text: string, x: number, top: number, size: number, bold = false, color = INK) => {
    const picked = await fonts.pick(bold ? "sansBold" : "sans", text);
    page.drawText(picked.text, { x, y: H - top, size, font: picked.font, color });
  };
  const line = (x0: number, x1: number, top: number) =>
    page.drawLine({ start: { x: x0, y: H - top }, end: { x: x1, y: H - top }, thickness: 0.8, color: INK });
  const field = (f: Omit<Field, "id" | "page" | "x" | "y" | "w" | "h" | "source">, x0: number, x1: number, lineTop: number, height: number) => {
    fields.push({
      ...f,
      id: `sp${pageIndex}_${fields.length + 1}`,
      page: pageIndex,
      x: x0 / W,
      w: (x1 - x0) / W,
      y: (lineTop - height) / H,
      h: (height + 1) / H,
      source: "generated",
    });
  };

  await draw("Signature page", M, 96, 18, true);
  await draw("By signing below, each party agrees to the terms of the agreement on the preceding pages.", M, 120, 10, false, MUTED);

  let top = 168;
  const parties: { label: string; assignee: string }[] = opts.roles.map((r) => ({ label: r.label, assignee: r.key }));
  if (opts.includeFirm) parties.push({ label: `For ${opts.firmName}`, assignee: AUTO });

  for (const party of parties) {
    const auto = party.assignee === AUTO;
    await draw(party.label, M, top, 11.5, true);
    const sigLine = top + 62;
    line(M, 360, sigLine);
    line(392, W - M, sigLine);
    await draw("Signature", M, sigLine + 12, 8.5, false, MUTED);
    await draw("Date", 392, sigLine + 12, 8.5, false, MUTED);
    field({ type: "signature", assignee: party.assignee, required: true }, M, 360, sigLine, 44);
    field({ type: "date", assignee: party.assignee, required: true }, 392, W - M, sigLine, 20);

    const nameLine = sigLine + 48;
    line(M, 360, nameLine);
    await draw("Printed name", M, nameLine + 12, 8.5, false, MUTED);
    if (auto) {
      field({ type: "text", assignee: AUTO, required: true, variable: "firm_signer_name", label: "Firm signer name" }, M, 360, nameLine, 20);
      line(392, W - M, nameLine);
      await draw("Title", 392, nameLine + 12, 8.5, false, MUTED);
      field({ type: "text", assignee: AUTO, required: false, variable: "firm_signer_title", label: "Firm signer title" }, 392, W - M, nameLine, 20);
    } else {
      field({ type: "name", assignee: party.assignee, required: true }, M, 360, nameLine, 20);
    }
    top = nameLine + 60;
  }

  return { bytes: await doc.save(), pageIndex, page: { width: W, height: H }, fields };
}
