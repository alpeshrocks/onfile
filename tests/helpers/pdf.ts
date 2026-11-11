import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { extractPdf } from "@/lib/extract";
import { toUserSpace } from "@/lib/geometry";

/** Read a PDF with pdf.js in Node, through the same extraction code the editor runs. */
export async function extract(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 }).promise;
  try {
    return await extractPdf(doc as never, pdfjs.Util.transform);
  } finally {
    await doc.destroy();
  }
}

/**
 * An agreement the way many firms have it: no underscore characters at all. Signature
 * lines are drawn rules with the label printed underneath, in two side by side blocks.
 */
export async function ruledAgreement() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const page = doc.addPage([612, 792]);
  const text = (s: string, x: number, y: number, f = font, size = 11) => page.drawText(s, { x, y, size, font: f });
  text("MIND CLIENT AGREEMENT", 72, 720, bold, 14);
  text("This agreement is between the Client and the Company for services described in Schedule A.", 72, 690);
  text("The Client authorizes the Company to act on the Client's behalf in connection with the file.", 72, 674);
  const rule = (x0: number, x1: number, y: number) => page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness: 0.75, color: rgb(0, 0, 0) });
  // Left block: client. Right block: company.
  text("CLIENT", 72, 560, bold);
  text("COMPANY", 340, 560, bold);
  rule(72, 280, 500);
  rule(340, 548, 500);
  text("Client Signature", 72, 488, font, 9);
  text("Authorized Signature", 340, 488, font, 9);
  rule(72, 280, 440);
  rule(340, 548, 440);
  text("Printed Name", 72, 428, font, 9);
  text("Printed Name", 340, 428, font, 9);
  rule(72, 200, 380);
  rule(340, 468, 380);
  text("Date", 72, 368, font, 9);
  text("Date", 340, 368, font, 9);
  return doc.save();
}

/**
 * A page stored rotated (as scanners and some exporters produce): the content is drawn
 * sideways or upside down in PDF space and /Rotate turns it upright for the reader. It is
 * always 612 by 792 as displayed. Positions are given the way a person sees the page;
 * pdf.js then acts as the independent judge of where things really ended up.
 */
export async function rotatedAgreement(rotation: 0 | 90 | 180 | 270, cropOffset = 0) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sideways = rotation === 90 || rotation === 270;
  const [w, h] = sideways ? [792, 612] : [612, 792];
  const page = doc.addPage([w, h]);
  if (cropOffset) {
    page.setMediaBox(0, 0, w + cropOffset * 2, h + cropOffset * 2);
    page.setCropBox(cropOffset, cropOffset, w, h);
  }
  const box = { x: cropOffset, y: cropOffset, width: w, height: h, rotation };
  const draw = (text: string, vx: number, vy: number, size: number) => {
    const p = toUserSpace(box, vx, vy);
    page.drawText(text, { x: p.x, y: p.y, size, font, rotate: degrees(rotation) });
  };
  draw("Service Agreement", 72, 92, 14);
  draw("Client Signature: ______________________________", 72, 392, 11);
  draw("Printed name: ___________________________", 72, 432, 11);
  page.setRotation(degrees(rotation));
  return doc.save();
}

/** A PDF with a real form layer (AcroForm). */
export async function formAgreement() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("Engagement Letter", { x: 72, y: 720, size: 14, font });
  const form = doc.getForm();
  form.createTextField("client_full_name").addToPage(page, { x: 72, y: 600, width: 240, height: 20 });
  form.createTextField("agreement_date").addToPage(page, { x: 340, y: 600, width: 120, height: 20 });
  form.createCheckBox("client_accepts_terms").addToPage(page, { x: 72, y: 560, width: 14, height: 14 });
  page.drawText("Client Signature: ______________________________", { x: 72, y: 480, size: 11, font });
  return doc.save();
}
