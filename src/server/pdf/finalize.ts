import { LineCapStyle, PDFDocument, PDFPage, degrees, rgb } from "pdf-lib";
import { EVENT_LABEL, utcStamp } from "@/lib/format";
import { displayedSize, fieldRect, normalizeRotation, toUserSpace, type PageBox } from "@/lib/geometry";
import { strokesToPath } from "@/lib/signature";
import type { EnvelopeField, FieldValue, FirmSigner, SignatureValue } from "@/lib/types";
import { Fonts, type Face } from "./fonts";

const INK = rgb(0.07, 0.11, 0.2);
const MUTED = rgb(0.38, 0.42, 0.48);
const RULE = rgb(0.85, 0.87, 0.9);
const BRAND = rgb(0.106, 0.247, 0.847);
const WHITE = rgb(1, 1, 1);

export function pageBoxOf(page: PDFPage): PageBox {
  const c = page.getCropBox();
  return { x: c.x, y: c.y, width: c.width, height: c.height, rotation: page.getRotation().angle };
}

function isSignature(v: unknown): v is SignatureValue {
  return typeof v === "object" && v !== null && "kind" in v;
}

function dataUrlBytes(dataUrl: string) {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

/** Draw a signature inside a rectangle given in displayed points (origin top left). */
async function drawSignature(
  doc: PDFDocument,
  page: PDFPage,
  box: PageBox,
  rect: { x: number; y: number; w: number; h: number },
  sig: SignatureValue,
) {
  const pad = Math.min(2, rect.h * 0.06);
  const scale = Math.min((rect.w - pad * 2) / sig.width, (rect.h - pad * 2) / sig.height);
  if (!(scale > 0) || !isFinite(scale)) return;
  const w = sig.width * scale;
  const h = sig.height * scale;
  const left = rect.x + pad;
  const top = rect.y + rect.h - pad - h; // sit on the signature line
  const rotate = degrees(normalizeRotation(box.rotation));

  if (sig.kind === "drawn") {
    const origin = toUserSpace(box, left, top);
    const pen = Math.min(1.6, Math.max(0.95, 2.2 * scale));
    page.drawSvgPath(strokesToPath(sig.strokes), {
      x: origin.x,
      y: origin.y,
      scale,
      rotate,
      borderColor: INK,
      borderWidth: pen / scale,
      borderLineCap: LineCapStyle.Round,
    });
  } else {
    const png = await doc.embedPng(dataUrlBytes(sig.dataUrl));
    const origin = toUserSpace(box, left, top + h);
    page.drawImage(png, { x: origin.x, y: origin.y, width: w, height: h, rotate });
  }
}

async function drawField(doc: PDFDocument, fonts: Fonts, page: PDFPage, field: EnvelopeField, value: FieldValue | undefined) {
  if (value === undefined || value === "" || value === false) return;
  const box = pageBoxOf(page);
  const rect = fieldRect(box, field);
  const rotate = degrees(normalizeRotation(box.rotation));

  if (field.mask) {
    const o = toUserSpace(box, rect.x, rect.y + rect.h);
    page.drawRectangle({ x: o.x, y: o.y, width: rect.w, height: rect.h, rotate, color: WHITE });
  }

  if (isSignature(value)) {
    await drawSignature(doc, page, box, rect, value);
    return;
  }

  if (value === true) {
    const p = (fx: number, fy: number) => toUserSpace(box, rect.x + rect.w * fx, rect.y + rect.h * fy);
    const thickness = Math.max(1, Math.min(rect.w, rect.h) * 0.12);
    page.drawLine({ start: p(0.2, 0.55), end: p(0.42, 0.78), thickness, color: INK, lineCap: LineCapStyle.Round });
    page.drawLine({ start: p(0.42, 0.78), end: p(0.82, 0.24), thickness, color: INK, lineCap: LineCapStyle.Round });
    return;
  }

  const { font, text } = await fonts.pick("sans", String(value));
  let size = field.fontSize ?? Math.min(11, Math.max(6.5, rect.h * 0.62));
  while (size > 5 && font.widthOfTextAtSize(text, size) > rect.w - 3) size -= 0.25;
  const o = toUserSpace(box, rect.x + 1.5, rect.y + rect.h / 2 + size * 0.34);
  page.drawText(text, { x: o.x, y: o.y, size, font, color: INK, rotate });
}

export interface CertificateSigner {
  name: string;
  email: string;
  roleLabel: string;
  viewedAt: Date | null;
  consentedAt: Date | null;
  signedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
  signature: SignatureValue | null;
}

export interface CertificateData {
  workspaceName: string;
  fileReference: string;
  fileTitle: string;
  templateName: string;
  templateVersion: number;
  docId: string;
  sourceSha256: string;
  sentAt: Date;
  completedAt: Date;
  pageCount: number;
  signers: CertificateSigner[];
  firmSigner: FirmSigner | null;
  events: { at: Date; type: string; actor: string; ip: string | null }[];
  auditHead: string;
  verifyUrl: string;
}

/** A tiny top-down layout cursor over pdf-lib's bottom-up coordinates. */
class Sheet {
  static W = 612;
  static H = 792;
  static M = 54;
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  constructor(
    private doc: PDFDocument,
    private fonts: Fonts,
  ) {
    this.addPage();
  }
  addPage() {
    this.page = this.doc.addPage([Sheet.W, Sheet.H]);
    this.pages.push(this.page);
    this.y = Sheet.M;
  }
  ensure(height: number) {
    if (this.y + height > Sheet.H - 70) this.addPage();
  }
  async text(str: string, x: number, y: number, size: number, face: Face = "sans", color = INK, maxWidth?: number) {
    const picked = await this.fonts.pick(face, str);
    let text = picked.text;
    if (maxWidth) {
      while (text.length > 4 && picked.font.widthOfTextAtSize(text, size) > maxWidth) text = text.slice(0, -4) + "...";
    }
    this.page.drawText(text, { x, y: Sheet.H - y, size, font: picked.font, color });
    return picked.font.widthOfTextAtSize(text, size);
  }
  rule(y: number, x0 = Sheet.M, x1 = Sheet.W - Sheet.M) {
    this.page.drawLine({ start: { x: x0, y: Sheet.H - y }, end: { x: x1, y: Sheet.H - y }, thickness: 0.6, color: RULE });
  }
}

function device(ua: string | null) {
  if (!ua) return "Not recorded";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return [browser, os].filter(Boolean).join(" on ") || ua.slice(0, 60);
}

async function drawCertificate(doc: PDFDocument, fonts: Fonts, c: CertificateData) {
  const s = new Sheet(doc, fonts);
  const M = Sheet.M;
  const right = Sheet.W - M;
  const stamp = (d: Date | null) => (d ? utcStamp(d) : "Not recorded");

  // Header
  await s.text("Certificate of completion", M, 78, 21, "sansBold");
  const mark = "Onfile";
  const markFont = await fonts.std("sansBold");
  await s.text(mark, right - markFont.widthOfTextAtSize(mark, 12), 70, 12, "sansBold", BRAND);
  const idFont = await fonts.std("mono");
  await s.text(c.docId, right - idFont.widthOfTextAtSize(c.docId, 8.5), 84, 8.5, "mono", MUTED);
  await s.text(`${c.templateName}, signed for file ${c.fileReference}`, M, 98, 10.5, "sans", MUTED, right - M);
  s.rule(112);

  // Summary grid
  const rows: [string, string][] = [
    ["Sent by", c.workspaceName],
    ["File", c.fileTitle ? `${c.fileReference} (${c.fileTitle})` : c.fileReference],
    ["Agreement", `${c.templateName}, version ${c.templateVersion}`],
    ["Pages signed", String(c.pageCount)],
    ["Sent", stamp(c.sentAt)],
    ["Completed", stamp(c.completedAt)],
  ];
  let y = 132;
  /** Start a new certificate page when fewer than `height` points remain. */
  const need = (height: number) => {
    s.y = y;
    const before = s.pages.length;
    s.ensure(height);
    if (s.pages.length !== before) y = M + 10;
  };
  for (let i = 0; i < rows.length; i += 2) {
    for (let col = 0; col < 2; col++) {
      const row = rows[i + col];
      if (!row) continue;
      const x = M + col * 258;
      await s.text(row[0], x, y, 8.5, "sans", MUTED);
      await s.text(row[1], x, y + 13, 10.5, "sansBold", INK, 240);
    }
    y += 36;
  }
  await s.text("Fingerprint of the document as sent (SHA-256)", M, y, 8.5, "sans", MUTED);
  await s.text(c.sourceSha256, M, y + 12, 8.5, "mono");
  y += 30;
  s.rule(y);
  y += 22;

  // Signers
  await s.text("Signatures", M, y, 13, "sansBold");
  y += 14;
  const signatureBox = async (sig: SignatureValue | null, top: number) => {
    const w = 136;
    const h = 56;
    const x = right - w;
    s.page.drawRectangle({ x, y: Sheet.H - top - h, width: w, height: h, borderColor: RULE, borderWidth: 0.8, color: rgb(0.985, 0.988, 0.992) });
    if (sig) {
      const box: PageBox = { x: 0, y: 0, width: Sheet.W, height: Sheet.H, rotation: 0 };
      await drawSignature(doc, s.page, box, { x: x + 6, y: top + 4, w: w - 12, h: h - 8 }, sig);
    }
  };

  for (const signer of c.signers) {
    need(96);
    const top = y;
    await s.text(signer.name, M, top + 16, 11, "sansBold", INK, 166);
    await s.text(signer.email, M, top + 30, 9, "sans", MUTED, 166);
    await s.text(signer.roleLabel, M, top + 43, 9, "sans", MUTED, 166);
    const facts: [string, string][] = [
      ["Opened", stamp(signer.viewedAt)],
      ["Agreed to e-sign", stamp(signer.consentedAt)],
      ["Signed", stamp(signer.signedAt)],
      ["IP address", signer.ip ?? "Not recorded"],
      ["Device", device(signer.userAgent)],
    ];
    let fy = top + 14;
    for (const [k, v] of facts) {
      await s.text(k, M + 176, fy, 8.5, "sans", MUTED);
      await s.text(v, M + 248, fy, 8.5, "sans", INK, 112);
      fy += 12.5;
    }
    await signatureBox(signer.signature, top + 6);
    y = top + 80;
    s.rule(y);
  }

  if (c.firmSigner) {
    need(96);
    const top = y;
    await s.text(c.firmSigner.name, M, top + 16, 11, "sansBold", INK, 166);
    await s.text(c.firmSigner.title || "Authorized signer", M, top + 30, 9, "sans", MUTED, 180);
    await s.text(`For ${c.workspaceName}`, M, top + 43, 9, "sans", MUTED, 180);
    await s.text("Basis", M + 176, top + 14, 8.5, "sans", MUTED);
    await s.text("Standing signature", M + 248, top + 14, 8.5, "sans", INK);
    await s.text("Applied", M + 176, top + 26.5, 8.5, "sans", MUTED);
    await s.text(stamp(c.sentAt), M + 248, top + 26.5, 8.5, "sans", INK);
    await signatureBox(c.firmSigner.signature, top + 6);
    y = top + 80;
    s.rule(y);
  }

  // Audit trail
  y += 24;
  need(70);
  await s.text("Audit trail", M, y, 13, "sansBold");
  y += 18;
  const cols = [M, M + 132, M + 300, M + 430];
  const header = async () => {
    await s.text("Time", cols[0], y, 8, "sansBold", MUTED);
    await s.text("Event", cols[1], y, 8, "sansBold", MUTED);
    await s.text("By", cols[2], y, 8, "sansBold", MUTED);
    await s.text("IP address", cols[3], y, 8, "sansBold", MUTED);
    y += 6;
    s.rule(y);
    y += 12;
  };
  await header();
  for (const e of c.events) {
    if (y > Sheet.H - 84) {
      s.addPage();
      y = M + 16;
      await header();
    }
    await s.text(utcStamp(e.at), cols[0], y, 8.5, "sans", INK);
    await s.text(EVENT_LABEL[e.type] ?? e.type, cols[1], y, 8.5, "sans", INK, 160);
    await s.text(e.actor, cols[2], y, 8.5, "sans", INK, 122);
    await s.text(e.ip ?? "", cols[3], y, 8.5, "sans", MUTED, 74);
    y += 14;
  }
  y += 8;
  need(30);
  await s.text("Audit chain head", M, y, 8.5, "sans", MUTED);
  await s.text(c.auditHead, M + 84, y, 7.5, "mono", MUTED);

  // Footer on every certificate page
  for (let i = 0; i < s.pages.length; i++) {
    s.page = s.pages[i];
    s.rule(Sheet.H - 62);
    await s.text(
      "Each signer agreed to use electronic records and signatures before signing (U.S. ESIGN Act, 15 U.S.C. 7001; UETA).",
      M,
      Sheet.H - 48,
      7.5,
      "sans",
      MUTED,
    );
    await s.text(`Verify this document at ${c.verifyUrl}`, M, Sheet.H - 37, 7.5, "sans", MUTED, right - M - 80);
    const label = `Certificate page ${i + 1} of ${s.pages.length}`;
    const f = await fonts.std("sans");
    await s.text(label, right - f.widthOfTextAtSize(label, 7.5), Sheet.H - 37, 7.5, "sans", MUTED);
  }
}

export interface FinalizeInput {
  source: Uint8Array;
  fields: EnvelopeField[];
  /** Values entered by signers, keyed by field id. AUTO fields carry their own value. */
  values: Record<string, FieldValue>;
  certificate: CertificateData;
}

/**
 * Produce the signed record: the original pages with every value drawn in place, the
 * document id printed on each page, and a certificate of completion appended.
 */
export async function finalizePdf(input: FinalizeInput): Promise<Uint8Array> {
  const doc = await PDFDocument.load(input.source, { updateMetadata: false });
  const fonts = new Fonts(doc);

  // Bake any pre-existing form fields into page content so nothing stays editable.
  try {
    const form = doc.getForm();
    if (form.getFields().length) form.flatten();
  } catch {
    // Malformed AcroForm: leave as is, our values are drawn on top regardless.
  }

  const pages = doc.getPages();
  for (const field of input.fields) {
    const page = pages[field.page];
    if (!page) continue;
    const value = field.value !== undefined ? field.value : input.values[field.id];
    await drawField(doc, fonts, page, field, value);
  }

  const idFont = await fonts.std("sans");
  for (const page of pages) {
    const box = pageBoxOf(page);
    const size = displayedSize(box);
    const o = toUserSpace(box, Math.min(18, size.width * 0.03), 13);
    page.drawText(`Onfile document ${input.certificate.docId}`, {
      x: o.x,
      y: o.y,
      size: 6.5,
      font: idFont,
      color: MUTED,
      rotate: degrees(normalizeRotation(box.rotation)),
    });
  }

  await drawCertificate(doc, fonts, { ...input.certificate, pageCount: pages.length });

  doc.setTitle(`${input.certificate.templateName} (${input.certificate.fileReference}), signed`);
  doc.setSubject(`Signed agreement ${input.certificate.docId}`);
  doc.setProducer("Onfile");
  doc.setCreator("Onfile");
  doc.setKeywords([input.certificate.docId, "signed"]);
  doc.setModificationDate(input.certificate.completedAt);
  return doc.save();
}

/**
 * Open a PDF and report what a template needs to know about it.
 * pdf-lib is lenient: it will "load" garbage and only fail later, deep inside a page
 * lookup. So everything, including a full trial save, happens here and any failure is
 * turned into one readable error, at upload time rather than when a client presses Finish.
 */
export async function inspectPdf(bytes: Uint8Array) {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/encrypt/i.test(message)) throw new PdfError("encrypted", "This PDF is password protected or encrypted.");
    throw new PdfError("unreadable", "This file could not be read as a PDF.");
  }
  let sizes: { width: number; height: number }[];
  try {
    sizes = doc.getPages().map((p) => displayedSize(pageBoxOf(p)));
    if (sizes.some((s) => !(s.width > 1 && s.height > 1))) throw new Error("degenerate page");
    await doc.save();
  } catch {
    throw new PdfError("unreadable", "This file could not be read as a PDF.");
  }
  if (sizes.length === 0) throw new PdfError("unreadable", "This PDF has no pages.");
  if (sizes.length > 150) throw new PdfError("too_long", "Agreements can be up to 150 pages.");
  return { pages: sizes };
}

export class PdfError extends Error {
  constructor(
    public code: "encrypted" | "unreadable" | "too_long",
    message: string,
  ) {
    super(message);
  }
}
