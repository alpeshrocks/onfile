import { and, desc, eq, gte, ilike, inArray, notInArray, or, sql } from "drizzle-orm";
import { now } from "../clock";
import { z } from "zod";
import { longDate } from "@/lib/format";
import { AUTO, DEFAULT_SETTINGS, type EnvelopeField, type Field, type FieldValue, type FileStatus, type FirmSigner } from "@/lib/types";
import { requiredInputs, templateIssues } from "@/lib/validate";
import { appendEvent } from "../audit";
import { AppError, defer, type Ctx } from "../context";
import { decrypt, encrypt, newDocId, newId, randomToken, sha256Hex } from "../crypto";
import { getDb, type DbOrTx, type Tx } from "../db";
import { envelopes, events, files, signers, templates, workspaces, type Envelope, type FileRow, type Signer, type Template, type Workspace } from "../db/schema";
import { sendEmail } from "../email";
import { emitWebhook } from "../webhooks";
import { resolveTemplate } from "./templates";

const signerInput = z.object({
  role: z.string().min(1).max(40),
  name: z.string().trim().min(1, "Enter the signer's name.").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(200),
});

export const createFileInput = z.object({
  reference: z.string().trim().max(60).optional(),
  title: z.string().trim().max(160).optional(),
  externalId: z.string().trim().min(1).max(120).optional(),
  templateId: z.string().max(60).optional(),
  signers: z.array(signerInput).min(1, "Add the client's name and email.").max(6),
  variables: z.record(z.string().max(500)).default({}),
  source: z.enum(["manual", "api", "csv", "demo"]).default("manual"),
});
export type CreateFileInput = z.input<typeof createFileInput>;

export function signingUrl(baseUrl: string, token: string) {
  return `${baseUrl}/sign/${token}`;
}

function settingsOf(ws: Workspace) {
  return { ...DEFAULT_SETTINGS, ...ws.settings };
}

async function nextReference(tx: Tx, workspaceId: string) {
  for (;;) {
    const [row] = await tx
      .update(workspaces)
      .set({ fileSeq: sql`${workspaces.fileSeq} + 1` })
      .where(eq(workspaces.id, workspaceId))
      .returning({ seq: workspaces.fileSeq });
    const reference = `F-${String(row.seq).padStart(4, "0")}`;
    const taken = await tx
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.workspaceId, workspaceId), eq(files.reference, reference)))
      .limit(1);
    if (!taken.length) return reference;
  }
}

/**
 * Fill every automatic field from the file's data and the firm's standing signature.
 * Shared by sending (the real thing) and the editor's client preview (sample data), so a
 * preview can never drift from what a client actually receives.
 */
export function resolveAutoFields(fields: Field[], known: Record<string, string>, firmSigner: FirmSigner | null | undefined) {
  let firmSigned = false;
  const resolved: EnvelopeField[] = fields.map((f) => {
    if (f.assignee !== AUTO) return f;
    let value: FieldValue = "";
    if (f.type === "signature" || f.type === "initials") {
      if (firmSigner) {
        value = firmSigner.signature;
        firmSigned = true;
      }
    } else if (f.type === "date") value = known.sent_date ?? "";
    else if (f.type === "name") value = known.firm_signer_name ?? "";
    else if (f.type === "checkbox") value = true;
    else value = (known[f.variable ?? ""] ?? "").trim();
    return { ...f, value };
  });
  return { fields: resolved, firmSigned };
}

interface SignerSeed {
  role: string;
  name: string;
  email: string;
}

/**
 * Create the agreement for a file: snapshot the template, resolve every automatic field
 * (file data, dates, the firm's standing signature), mint one private link per signer and
 * open the audit trail. Runs inside the caller's transaction.
 */
async function createEnvelope(
  tx: Tx,
  ctx: Ctx,
  ws: Workspace,
  file: FileRow,
  template: Template,
  seeds: SignerSeed[],
  variables: Record<string, string>,
  at = now(),
) {
  const settings = settingsOf(ws);
  const problems = templateIssues({ ...template, pageCount: template.pages.length }, Boolean(ws.firmSigner)).filter((i) => i.level === "error");
  if (problems.length) throw new AppError(`"${template.name}" cannot be sent yet: ${problems[0].message}`, "invalid_template", 409);

  const people = template.roles.map((role) => {
    const seed = seeds.find((s) => s.role === role.key);
    if (!seed) throw new AppError(`Add a name and email for ${role.label}.`, "missing_signer", 422);
    return { ...seed, label: role.label };
  });
  for (const v of requiredInputs(template)) {
    if (v.required && !variables[v.key]?.trim()) throw new AppError(`"${v.label}" is required for this agreement.`, "missing_variable", 422);
  }

  const primary = people[0];
  const known: Record<string, string> = {
    ...variables,
    client_name: primary.name,
    client_email: primary.email,
    file_reference: file.reference,
    file_title: file.title,
    sent_date: longDate(at, settings.timeZone),
    firm_name: ws.name,
    firm_signer_name: ws.firmSigner?.name ?? "",
    firm_signer_title: ws.firmSigner?.title ?? "",
  };
  const { fields: resolved, firmSigned } = resolveAutoFields(template.fields, known, ws.firmSigner);

  const envelopeId = newId("env");
  const [envelope] = await tx
    .insert(envelopes)
    .values({
      id: envelopeId,
      workspaceId: ws.id,
      fileId: file.id,
      docId: newDocId(),
      templateId: template.id,
      templateName: template.name,
      templateVersion: template.version,
      sourceBlobId: template.blobId,
      sourceSha256: template.sha256,
      pages: template.pages,
      fields: resolved,
      status: "sent",
      sentAt: at,
      expiresAt: settings.expiryDays > 0 ? new Date(at.getTime() + settings.expiryDays * 86_400_000) : null,
      createdAt: at,
    })
    .returning();

  const created: (Signer & { token: string })[] = [];
  for (const p of people) {
    const token = randomToken(32);
    const [row] = await tx
      .insert(signers)
      .values({
        id: newId("sgn"),
        workspaceId: ws.id,
        envelopeId,
        roleKey: p.role,
        roleLabel: p.label,
        name: p.name,
        email: p.email,
        tokenHash: sha256Hex(token),
        tokenEnc: encrypt(token),
      })
      .returning();
    created.push({ ...row, token });
  }

  await appendEvent(tx, {
    workspaceId: ws.id,
    envelopeId,
    fileId: file.id,
    type: "agreement.sent",
    actor: ctx.actor,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    at,
    data: {
      agreement: template.name,
      version: template.version,
      documentSha256: template.sha256,
      signers: people.map((p) => ({ name: p.name, email: p.email, role: p.label })),
    },
  });
  if (firmSigned && ws.firmSigner) {
    await appendEvent(tx, {
      workspaceId: ws.id,
      envelopeId,
      fileId: file.id,
      type: "agreement.firm_signed",
      actor: { kind: "system", name: ws.firmSigner.name },
      at,
      data: { name: ws.firmSigner.name, title: ws.firmSigner.title, basis: "standing signature" },
    });
  }
  await tx.update(files).set({ status: "awaiting_signature", updatedAt: at }).where(eq(files.id, file.id));
  return { envelope, signers: created, template };
}

/** Emails and webhooks for a freshly sent agreement. Runs after the transaction commits. */
async function deliver(
  ctx: Ctx,
  ws: Workspace,
  file: FileRow,
  envelope: Envelope,
  template: Pick<Template, "name" | "emailSubject" | "emailMessage">,
  people: (Signer & { token: string })[],
  announce = true,
) {
  const db = await getDb();
  const settings = settingsOf(ws);
  for (const p of people) {
    await sendEmail(db, {
      workspaceId: ws.id,
      envelopeId: envelope.id,
      fileId: file.id,
      kind: "signature_request",
      to: p.email,
      toName: p.name,
      fromName: ws.name,
      replyTo: settings.replyTo || undefined,
      subject: template.emailSubject || `${ws.name} needs your signature`,
      content: {
        firmName: ws.name,
        brandColor: ws.brandColor,
        heading: "Your agreement is ready to sign",
        paragraphs: [
          `Hello ${p.name.split(" ")[0]},`,
          `${ws.name} needs your signature on the ${template.name} before work on your file can begin. It takes about two minutes and works on a phone.`,
        ],
        note: template.emailMessage || undefined,
        details: [
          ["File", file.title ? `${file.reference} (${file.title})` : file.reference],
          ["Agreement", template.name],
        ],
        cta: { label: "Review and sign", url: signingUrl(ctx.baseUrl, p.token) },
        footnote: "This link is private to you. Please do not forward it.",
      },
    });
  }
  if (announce) await emitWebhook(db, ws.id, "agreement.sent", filePayload(file, envelope, people, ctx.baseUrl));
}

/**
 * Open a file and send its agreement in one step. This is the product's core promise:
 * creating the file is the only action staff (or an integration) ever takes.
 */
export async function createFile(ctx: Ctx, raw: CreateFileInput) {
  const input = createFileInput.parse(raw);
  const db = await getDb();

  const result = await db.transaction(async (tx) => {
    if (input.externalId) {
      const [existing] = await tx
        .select()
        .from(files)
        .where(and(eq(files.workspaceId, ctx.workspaceId), eq(files.externalId, input.externalId)))
        .limit(1);
      if (existing) return { existing: true as const, file: existing };
    }
    const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1);
    if (!ws) throw new AppError("Workspace not found.", "not_found", 404);
    const template = await resolveTemplate(tx, ctx.workspaceId, input.templateId);

    let reference = input.reference;
    if (reference) {
      const taken = await tx
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.workspaceId, ctx.workspaceId), eq(files.reference, reference)))
        .limit(1);
      if (taken.length) throw new AppError(`A file with reference ${reference} already exists.`, "duplicate_reference", 409);
    } else reference = await nextReference(tx, ctx.workspaceId);

    const primary = input.signers.find((s) => s.role === template.roles[0]?.key) ?? input.signers[0];
    const [file] = await tx
      .insert(files)
      .values({
        id: newId("file"),
        workspaceId: ctx.workspaceId,
        reference,
        title: input.title ?? "",
        clientName: primary.name,
        clientEmail: primary.email,
        status: "draft",
        externalId: input.externalId ?? null,
        source: input.source,
        variables: input.variables,
        createdBy: ctx.userId ?? null,
        createdByEmail: ctx.actor.email ?? null,
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
    const sent = await createEnvelope(tx, ctx, ws, file, template, input.signers, input.variables);
    return { existing: false as const, file: { ...file, status: "awaiting_signature" as FileStatus }, ws, ...sent };
  });

  if (result.existing) {
    const detail = await getFile(ctx, result.file.id);
    return { existing: true, file: result.file, envelope: detail?.envelopes[0] ?? null, signers: detail?.envelopes[0]?.signers ?? [] };
  }
  defer(() => deliver(ctx, result.ws, result.file, result.envelope, result.template, result.signers));
  return {
    existing: false,
    file: result.file,
    envelope: result.envelope,
    signers: result.signers.map((s) => ({ ...s, url: signingUrl(ctx.baseUrl, s.token) })),
  };
}

/** Send a fresh agreement on an existing file (after a decline, void or expiry). */
export async function resendAgreement(ctx: Ctx, fileId: string, opts: { templateId?: string } = {}) {
  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    const [file] = await tx
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.workspaceId, ctx.workspaceId)))
      .for("update");
    if (!file) throw new AppError("File not found.", "not_found", 404);
    if (file.status === "awaiting_signature") throw new AppError("An agreement is already out for signature on this file. Void it first.", "conflict", 409);
    if (file.status === "signed") throw new AppError("This file is already signed.", "conflict", 409);
    const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1);
    const [last] = await tx.select().from(envelopes).where(eq(envelopes.fileId, fileId)).orderBy(desc(envelopes.sentAt)).limit(1);
    const template = await resolveTemplate(tx, ctx.workspaceId, opts.templateId ?? last?.templateId).catch(() => resolveTemplate(tx, ctx.workspaceId));
    const previous = last ? await tx.select().from(signers).where(eq(signers.envelopeId, last.id)) : [];
    const seeds: SignerSeed[] = previous.length
      ? previous.map((p) => ({ role: p.roleKey, name: p.name, email: p.email }))
      : [{ role: template.roles[0].key, name: file.clientName, email: file.clientEmail }];
    const sent = await createEnvelope(tx, ctx, ws, file, template, seeds, file.variables);
    return { ws, file, ...sent };
  });
  defer(() => deliver(ctx, result.ws, result.file, result.envelope, result.template, result.signers));
  return { envelope: result.envelope };
}

export async function voidAgreement(ctx: Ctx, envelopeId: string, reason: string) {
  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    const [envelope] = await tx
      .select()
      .from(envelopes)
      .where(and(eq(envelopes.id, envelopeId), eq(envelopes.workspaceId, ctx.workspaceId)))
      .for("update");
    if (!envelope) throw new AppError("Agreement not found.", "not_found", 404);
    if (envelope.status !== "sent" && envelope.status !== "partially_signed") {
      throw new AppError("Only an agreement that is out for signature can be voided.", "conflict", 409);
    }
    await tx.update(envelopes).set({ status: "voided" }).where(eq(envelopes.id, envelopeId));
    await tx.update(files).set({ status: "voided", updatedAt: now() }).where(eq(files.id, envelope.fileId));
    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      envelopeId,
      fileId: envelope.fileId,
      type: "agreement.voided",
      actor: ctx.actor,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      data: { reason: reason.slice(0, 300) },
    });
    const [file] = await tx.select().from(files).where(eq(files.id, envelope.fileId));
    const people = await tx.select().from(signers).where(eq(signers.envelopeId, envelopeId));
    return { envelope: { ...envelope, status: "voided" as const }, file, people };
  });
  defer(async () => {
    await emitWebhook(db, ctx.workspaceId, "agreement.voided", filePayload(result.file, result.envelope, result.people, ctx.baseUrl));
  });
}

const signerPatch = z.object({
  name: z.string().trim().min(1, "Enter the signer's name.").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(200),
});

/**
 * Correct a signer's name or email after sending (the everyday typo).
 *
 * The old link may already be in the wrong person's inbox, so it is revoked: the signer
 * gets a fresh link and starts again as "not opened". A printed name can only change while
 * nobody has signed, because other parties signed the document as it was. The correction
 * is written to the audit trail with the before and after values.
 */
export async function updateSigner(ctx: Ctx, signerId: string, raw: unknown) {
  const input = signerPatch.parse(raw);
  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    const [found] = await tx
      .select()
      .from(signers)
      .where(and(eq(signers.id, signerId), eq(signers.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (!found) throw new AppError("Signer not found.", "not_found", 404);
    const [envelope] = await tx.select().from(envelopes).where(eq(envelopes.id, found.envelopeId)).for("update");
    if (envelope.status !== "sent" && envelope.status !== "partially_signed") {
      throw new AppError("This agreement is no longer out for signature.", "conflict", 409);
    }
    const everyone = await tx.select().from(signers).where(eq(signers.envelopeId, envelope.id));
    const signer = everyone.find((s) => s.id === signerId)!;
    if (signer.status === "signed" || signer.status === "declined") {
      throw new AppError("This signer has already responded, so their details can no longer change.", "conflict", 409);
    }
    const nameChanged = input.name !== signer.name;
    const emailChanged = input.email !== signer.email;
    if (!nameChanged && !emailChanged) throw new AppError("Nothing was changed.", "unchanged", 422);
    if (nameChanged && everyone.some((s) => s.status === "signed")) {
      throw new AppError("Someone has already signed this agreement, so names can no longer change. Void it and send a new one.", "conflict", 409);
    }

    const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
    const [file] = await tx.select().from(files).where(eq(files.id, envelope.fileId));
    const [template] = await tx.select().from(templates).where(eq(templates.id, envelope.templateId)).limit(1);

    const token = randomToken(32);
    const [updated] = await tx
      .update(signers)
      .set({
        name: input.name,
        email: input.email,
        tokenHash: sha256Hex(token),
        tokenEnc: encrypt(token),
        status: "pending",
        viewedAt: null,
        consentedAt: null,
        ip: null,
        userAgent: null,
      })
      .where(eq(signers.id, signerId))
      .returning();

    // The file's client is the first signer: their details are printed on the agreement
    // and shown on the file, so both follow the correction.
    const isPrimary = signer.name === file.clientName && signer.email === file.clientEmail;
    let fields = envelope.fields;
    let fileRow = file;
    if (isPrimary) {
      fields = envelope.fields.map((f) =>
        f.assignee === AUTO && f.type === "text" && f.variable === "client_name"
          ? { ...f, value: input.name }
          : f.assignee === AUTO && f.type === "text" && f.variable === "client_email"
            ? { ...f, value: input.email }
            : f,
      );
      await tx.update(envelopes).set({ fields }).where(eq(envelopes.id, envelope.id));
      [fileRow] = await tx.update(files).set({ clientName: input.name, clientEmail: input.email, updatedAt: now() }).where(eq(files.id, file.id)).returning();
    }

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      envelopeId: envelope.id,
      fileId: file.id,
      type: "agreement.signer_updated",
      actor: ctx.actor,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      data: { role: signer.roleLabel, from: { name: signer.name, email: signer.email }, to: { name: input.name, email: input.email }, linkReissued: true },
    });
    return { ws, file: fileRow, envelope: { ...envelope, fields }, updated: { ...updated, token }, template };
  });

  defer(() =>
    deliver(
      ctx,
      result.ws,
      result.file,
      result.envelope,
      { name: result.envelope.templateName, emailSubject: result.template?.emailSubject ?? "", emailMessage: result.template?.emailMessage ?? "" },
      [result.updated],
      false,
    ),
  );
  return { url: signingUrl(ctx.baseUrl, result.updated.token) };
}

/** Nudge everyone who has not signed yet. Used by the reminder schedule and the manual button. */
export async function remindAgreement(ctx: Ctx, envelopeId: string, opts: { automatic?: boolean } = {}) {
  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    const [envelope] = await tx
      .select()
      .from(envelopes)
      .where(and(eq(envelopes.id, envelopeId), eq(envelopes.workspaceId, ctx.workspaceId)))
      .for("update");
    if (!envelope || (envelope.status !== "sent" && envelope.status !== "partially_signed")) {
      throw new AppError("This agreement is no longer waiting for signatures.", "conflict", 409);
    }
    const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
    const [file] = await tx.select().from(files).where(eq(files.id, envelope.fileId));
    const waiting = (await tx.select().from(signers).where(eq(signers.envelopeId, envelopeId))).filter(
      (s) => s.status === "pending" || s.status === "viewed",
    );
    await tx
      .update(envelopes)
      .set({ reminderCount: envelope.reminderCount + 1, lastReminderAt: now() })
      .where(eq(envelopes.id, envelopeId));
    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      envelopeId,
      fileId: envelope.fileId,
      type: "agreement.reminded",
      actor: ctx.actor,
      data: { to: waiting.map((s) => s.email), automatic: Boolean(opts.automatic) },
    });
    return { envelope, ws, file, waiting };
  });

  const send = async () => {
    for (const s of result.waiting) {
      await sendEmail(db, {
        workspaceId: ctx.workspaceId,
        envelopeId,
        fileId: result.file.id,
        kind: "reminder",
        to: s.email,
        toName: s.name,
        fromName: result.ws.name,
        replyTo: settingsOf(result.ws).replyTo || undefined,
        subject: `Reminder: ${result.ws.name} is waiting for your signature`,
        content: {
          firmName: result.ws.name,
          brandColor: result.ws.brandColor,
          heading: "Your agreement is still waiting",
          paragraphs: [
            `Hello ${s.name.split(" ")[0]},`,
            `Work on your file (${result.file.reference}) starts once the ${result.envelope.templateName} is signed. It takes about two minutes.`,
          ],
          cta: { label: "Review and sign", url: signingUrl(ctx.baseUrl, decrypt(s.tokenEnc)) },
          footnote: result.envelope.expiresAt ? `This request expires on ${longDate(result.envelope.expiresAt)}.` : undefined,
        },
      });
    }
  };
  if (opts.automatic) await send();
  else defer(send);
  return { reminded: result.waiting.length };
}

/** Shape shared by webhooks and the REST API. */
export function filePayload(
  file: FileRow,
  envelope: Pick<Envelope, "id" | "docId" | "status" | "sentAt" | "completedAt" | "expiresAt" | "templateName" | "signedSha256"> | null,
  people: Pick<Signer, "roleKey" | "name" | "email" | "status" | "viewedAt" | "signedAt" | "tokenEnc">[],
  baseUrl: string,
) {
  return {
    file: {
      id: file.id,
      reference: file.reference,
      external_id: file.externalId,
      title: file.title,
      status: file.status,
      cleared_to_start: file.status === "signed",
      client: { name: file.clientName, email: file.clientEmail },
      created_at: file.createdAt.toISOString(),
    },
    agreement: envelope && {
      id: envelope.id,
      document_id: envelope.docId,
      name: envelope.templateName,
      status: envelope.status,
      sent_at: envelope.sentAt.toISOString(),
      completed_at: envelope.completedAt?.toISOString() ?? null,
      expires_at: envelope.expiresAt?.toISOString() ?? null,
      signed_sha256: envelope.signedSha256,
      signers: people.map((s) => ({
        role: s.roleKey,
        name: s.name,
        email: s.email,
        status: s.status,
        viewed_at: s.viewedAt?.toISOString() ?? null,
        signed_at: s.signedAt?.toISOString() ?? null,
        signing_url: s.status === "signed" || s.status === "declined" ? null : signingUrl(baseUrl, decrypt(s.tokenEnc)),
      })),
    },
  };
}

export async function getFile(ctx: Ctx, id: string) {
  const db = await getDb();
  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.workspaceId, ctx.workspaceId), or(eq(files.id, id), eq(files.reference, id), eq(files.externalId, id))))
    .limit(1);
  if (!file) return null;
  const envs = await db.select().from(envelopes).where(eq(envelopes.fileId, file.id)).orderBy(desc(envelopes.sentAt));
  const ids = envs.map((e) => e.id);
  const people = ids.length ? await db.select().from(signers).where(inArray(signers.envelopeId, ids)) : [];
  const trail = ids.length ? await db.select().from(events).where(inArray(events.envelopeId, ids)).orderBy(desc(events.createdAt), desc(events.seq)) : [];
  return {
    file,
    envelopes: envs.map((e) => ({
      ...e,
      signers: people
        .filter((p) => p.envelopeId === e.id)
        .map((p) => ({ ...p, url: signingUrl(ctx.baseUrl, decrypt(p.tokenEnc)) })),
    })),
    events: trail,
  };
}

export async function listFiles(ctx: Ctx, opts: { status?: FileStatus | "all"; q?: string; limit?: number } = {}) {
  const db = await getDb();
  const where = [eq(files.workspaceId, ctx.workspaceId)];
  if (opts.status && opts.status !== "all") where.push(eq(files.status, opts.status));
  if (opts.q?.trim()) {
    const q = `%${opts.q.trim().replace(/[%_\\]/g, "\\$&")}%`;
    where.push(or(ilike(files.clientName, q), ilike(files.reference, q), ilike(files.clientEmail, q), ilike(files.title, q))!);
  }
  const rows = await db
    .select()
    .from(files)
    .where(and(...where))
    .orderBy(desc(files.createdAt))
    .limit(opts.limit ?? 200);
  return attachProgress(db, rows);
}

async function attachProgress(db: DbOrTx, rows: FileRow[]) {
  if (!rows.length) return [];
  const envs = await db
    .select({
      id: envelopes.id,
      fileId: envelopes.fileId,
      status: envelopes.status,
      sentAt: envelopes.sentAt,
      completedAt: envelopes.completedAt,
      reminderCount: envelopes.reminderCount,
      templateName: envelopes.templateName,
    })
    .from(envelopes)
    .where(
      inArray(
        envelopes.fileId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(desc(envelopes.sentAt));
  const latest = new Map<string, (typeof envs)[number]>();
  for (const e of envs) if (!latest.has(e.fileId)) latest.set(e.fileId, e);
  const ids = [...latest.values()].map((e) => e.id);
  const people = ids.length
    ? await db
        .select({ envelopeId: signers.envelopeId, status: signers.status, viewedAt: signers.viewedAt, signedAt: signers.signedAt, name: signers.name })
        .from(signers)
        .where(inArray(signers.envelopeId, ids))
    : [];
  return rows.map((file) => {
    const envelope = latest.get(file.id) ?? null;
    const mine = envelope ? people.filter((p) => p.envelopeId === envelope.id) : [];
    return {
      ...file,
      envelope,
      signerCount: mine.length,
      signedCount: mine.filter((p) => p.status === "signed").length,
      viewed: mine.some((p) => p.viewedAt),
    };
  });
}

export type FileListItem = Awaited<ReturnType<typeof listFiles>>[number];

export async function dashboard(ctx: Ctx) {
  const db = await getDb();
  const counts = await db
    .select({ status: files.status, n: sql<number>`count(*)::int` })
    .from(files)
    .where(eq(files.workspaceId, ctx.workspaceId))
    .groupBy(files.status);
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n])) as Partial<Record<FileStatus, number>>;

  const since = new Date(now().getTime() - 90 * 86_400_000);
  const completed = await db
    .select({ sentAt: envelopes.sentAt, completedAt: envelopes.completedAt })
    .from(envelopes)
    .where(and(eq(envelopes.workspaceId, ctx.workspaceId), eq(envelopes.status, "completed"), gte(envelopes.completedAt, since)));
  const durations = completed.map((c) => c.completedAt!.getTime() - c.sentAt.getTime()).sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor((durations.length - 1) / 2)] : null;
  const weekAgo = now().getTime() - 7 * 86_400_000;

  const open = await attachProgress(
    db,
    await db
      .select()
      .from(files)
      .where(and(eq(files.workspaceId, ctx.workspaceId), inArray(files.status, ["awaiting_signature", "declined", "expired"])))
      .orderBy(files.createdAt)
      .limit(100),
  );
  const recent = await db
    .select({
      id: events.id,
      type: events.type,
      actor: events.actor,
      createdAt: events.createdAt,
      fileId: events.fileId,
      reference: files.reference,
      clientName: files.clientName,
    })
    .from(events)
    .innerJoin(files, eq(files.id, events.fileId))
    .where(and(eq(events.workspaceId, ctx.workspaceId), notInArray(events.type, ["agreement.firm_signed", "agreement.consented"])))
    .orderBy(desc(events.createdAt), desc(events.seq))
    .limit(10);

  const total = counts.reduce((s, c) => s + c.n, 0);
  const signed = byStatus.signed ?? 0;
  const decided = signed + (byStatus.declined ?? 0) + (byStatus.expired ?? 0);
  return {
    total,
    awaiting: byStatus.awaiting_signature ?? 0,
    signed,
    signedThisWeek: completed.filter((c) => c.completedAt!.getTime() >= weekAgo).length,
    blocked: (byStatus.declined ?? 0) + (byStatus.expired ?? 0),
    medianMs: median,
    completionRate: decided ? signed / decided : null,
    open,
    recent,
  };
}
