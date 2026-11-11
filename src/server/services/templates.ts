import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { AUTO, DEFAULT_ROLES, fieldSchema, roleSchema, variableSchema } from "@/lib/types";
import { templateIssues } from "@/lib/validate";
import { getBlob, putBlob } from "../blobs";
import { AppError, type Ctx } from "../context";
import { newId } from "../crypto";
import { getDb, type DbOrTx } from "../db";
import { templates, workspaces } from "../db/schema";
import { inspectPdf, PdfError } from "../pdf/finalize";
import { appendSignaturePage, docxToBlocks, imagesToPdf, textToBlocks, typesetBlocks } from "../pdf/typeset";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function sniff(bytes: Uint8Array, filename: string): "pdf" | "docx" | "png" | "jpeg" | "text" | "doc" | "unknown" {
  const head = Buffer.from(bytes.subarray(0, 8));
  if (head.subarray(0, 5).toString("latin1") === "%PDF-" || Buffer.from(bytes.subarray(0, 1024)).includes("%PDF-")) return "pdf";
  if (head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG") return "png";
  if (head[0] === 0xff && head[1] === 0xd8) return "jpeg";
  if (head[0] === 0x50 && head[1] === 0x4b) return /\.docx$/i.test(filename) ? "docx" : "unknown";
  if (head[0] === 0xd0 && head[1] === 0xcf) return "doc";
  if (/\.(txt|md|text)$/i.test(filename)) return "text";
  // Unlabelled text: accept when it decodes cleanly and has no binary control bytes.
  const sample = bytes.subarray(0, 4096);
  if (!sample.some((b) => b < 9 || (b > 13 && b < 32))) return "text";
  return "unknown";
}

function nameFrom(filename: string) {
  const base = filename
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (base || "Client agreement").slice(0, 80);
}

/**
 * Accept an agreement in whatever form the firm has it and turn it into a draft template.
 * PDFs are stored untouched; Word, text and images are converted to PDF first.
 */
export async function ingestDocument(ctx: Ctx, input: { bytes: Uint8Array; filename: string }) {
  if (input.bytes.byteLength === 0) throw new AppError("That file is empty.");
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new AppError("Files can be up to 25 MB.", "too_large", 413);

  const kind = sniff(input.bytes, input.filename);
  let pdf: Uint8Array;
  let converted = false;
  try {
    if (kind === "pdf") pdf = input.bytes;
    else if (kind === "docx") {
      pdf = await typesetBlocks(await docxToBlocks(input.bytes), { title: nameFrom(input.filename) });
      converted = true;
    } else if (kind === "text") {
      const text = new TextDecoder("utf-8").decode(input.bytes);
      if (!text.trim()) throw new AppError("That file has no text in it.");
      pdf = await typesetBlocks(textToBlocks(text), { title: nameFrom(input.filename) });
      converted = true;
    } else if (kind === "png" || kind === "jpeg") {
      pdf = await imagesToPdf([{ bytes: input.bytes, type: kind === "png" ? "image/png" : "image/jpeg" }]);
      converted = true;
    } else if (kind === "doc") {
      throw new AppError("Older .doc files are not supported. Save it as PDF or .docx in Word, then upload that.", "unsupported", 415);
    } else {
      throw new AppError("Upload a PDF, a Word document (.docx), a photo or scan (PNG, JPG), or a text file.", "unsupported", 415);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("That document could not be converted. Save it as a PDF and upload that instead.", "conversion_failed", 422);
  }

  let pages;
  try {
    ({ pages } = await inspectPdf(pdf));
  } catch (err) {
    if (err instanceof PdfError) throw new AppError(err.message, `pdf_${err.code}`, 422);
    throw err;
  }

  const db = await getDb();
  const blob = await putBlob(db, ctx.workspaceId, pdf, "application/pdf");
  const id = newId("tpl");
  await db.insert(templates).values({
    id,
    workspaceId: ctx.workspaceId,
    name: nameFrom(input.filename),
    blobId: blob.id,
    sha256: blob.sha256,
    pages,
    roles: DEFAULT_ROLES,
    createdBy: ctx.userId ?? null,
  });
  return { id, converted, pageCount: pages.length };
}

export async function listTemplates(ctx: Ctx) {
  const db = await getDb();
  return db
    .select()
    .from(templates)
    .where(and(eq(templates.workspaceId, ctx.workspaceId), ne(templates.status, "archived")))
    .orderBy(desc(templates.isDefault), desc(templates.updatedAt));
}

export async function getTemplate(db: DbOrTx, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.id, id), eq(templates.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export const templatePatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  fields: z.array(fieldSchema).max(400).optional(),
  roles: z.array(roleSchema).min(1).max(4).optional(),
  variables: z.array(variableSchema).max(40).optional(),
  emailSubject: z.string().trim().max(140).optional(),
  emailMessage: z.string().trim().max(1200).optional(),
});

/**
 * Save editor state. Drafts save freely. Publishing, or saving a template that is already
 * live, must pass validation, and bumps the version so every sent agreement can name the
 * exact revision it was produced from.
 */
export async function saveTemplate(ctx: Ctx, id: string, raw: unknown, opts: { publish?: boolean } = {}) {
  const patch = templatePatch.parse(raw);
  const db = await getDb();
  return db.transaction(async (tx) => {
    const current = await getTemplate(tx, ctx.workspaceId, id);
    if (!current || current.status === "archived") throw new AppError("Agreement not found.", "not_found", 404);
    const next = {
      name: patch.name ?? current.name,
      fields: patch.fields ?? current.fields,
      roles: patch.roles ?? current.roles,
      variables: patch.variables ?? current.variables,
      emailSubject: patch.emailSubject ?? current.emailSubject,
      emailMessage: patch.emailMessage ?? current.emailMessage,
    };
    const ids = new Set<string>();
    for (const f of next.fields) {
      if (ids.has(f.id)) throw new AppError("Two fields share the same id.");
      ids.add(f.id);
    }

    const live = opts.publish || current.status === "active";
    if (live) {
      const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1);
      const errors = templateIssues({ ...next, pageCount: current.pages.length }, Boolean(ws?.firmSigner)).filter((i) => i.level === "error");
      if (errors.length) throw new AppError(errors[0].message, "invalid_template", 422);
    }

    let isDefault = current.isDefault;
    if (opts.publish && current.status !== "active") {
      const others = await tx
        .select({ id: templates.id })
        .from(templates)
        .where(and(eq(templates.workspaceId, ctx.workspaceId), eq(templates.isDefault, true), eq(templates.status, "active")))
        .limit(1);
      if (!others.length) isDefault = true;
    }

    const [row] = await tx
      .update(templates)
      .set({
        ...next,
        detected: true,
        isDefault,
        status: live ? "active" : current.status,
        version: live ? current.version + 1 : current.version,
        publishedAt: live ? new Date() : current.publishedAt,
        updatedAt: new Date(),
      })
      .where(eq(templates.id, id))
      .returning();
    return row;
  });
}

export async function setDefaultTemplate(ctx: Ctx, id: string) {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const t = await getTemplate(tx, ctx.workspaceId, id);
    if (!t || t.status !== "active") throw new AppError("Only a published agreement can be the default.");
    await tx.update(templates).set({ isDefault: false }).where(eq(templates.workspaceId, ctx.workspaceId));
    await tx.update(templates).set({ isDefault: true }).where(eq(templates.id, id));
  });
}

export async function archiveTemplate(ctx: Ctx, id: string) {
  const db = await getDb();
  await db
    .update(templates)
    .set({ status: "archived", isDefault: false, updatedAt: new Date() })
    .where(and(eq(templates.id, id), eq(templates.workspaceId, ctx.workspaceId)));
}

/** Add an Onfile-drawn signature page, with its fields already placed. */
export async function addSignaturePage(ctx: Ctx, id: string, opts: { includeFirm: boolean }) {
  const db = await getDb();
  const current = await getTemplate(db, ctx.workspaceId, id);
  if (!current) throw new AppError("Agreement not found.", "not_found", 404);
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1);
  const blob = await getBlob(db, ctx.workspaceId, current.blobId);
  if (!blob) throw new AppError("The document for this agreement is missing.", "not_found", 404);

  const result = await appendSignaturePage(blob.data, { roles: current.roles, firmName: ws.name, includeFirm: opts.includeFirm });
  const stored = await putBlob(db, ctx.workspaceId, result.bytes, "application/pdf");
  // Signature fields the page now provides replace any stray ones for the same parties.
  const provided = new Set(result.fields.filter((f) => f.type === "signature").map((f) => f.assignee));
  const kept = current.fields.filter((f) => !(f.type === "signature" && provided.has(f.assignee) && f.source === "generated"));
  const [row] = await db
    .update(templates)
    .set({
      blobId: stored.id,
      sha256: stored.sha256,
      pages: [...current.pages, result.page],
      fields: [...kept, ...result.fields],
      detected: true,
      updatedAt: new Date(),
    })
    .where(eq(templates.id, id))
    .returning();
  return row;
}

/** The template a new file uses when none is named: the workspace default. */
export async function resolveTemplate(db: DbOrTx, workspaceId: string, templateId?: string | null) {
  if (templateId) {
    const t = await getTemplate(db, workspaceId, templateId);
    if (!t || t.status !== "active") throw new AppError("That agreement is not published.", "template_not_found", 404);
    return t;
  }
  const [t] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.workspaceId, workspaceId), eq(templates.status, "active")))
    .orderBy(desc(templates.isDefault), desc(templates.publishedAt))
    .limit(1);
  if (!t) throw new AppError("Publish an agreement first. Files are sent the default agreement automatically.", "no_template", 409);
  return t;
}

export { AUTO };
