import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { isValidTimeZone, longDate } from "@/lib/format";
import { inkLength } from "@/lib/signature";
import { AUTO, DEFAULT_SETTINGS, signatureValueSchema, type EnvelopeField, type FieldValue, type SignatureValue } from "@/lib/types";
import { appendEvent, envelopeEvents, verifyChain } from "../audit";
import { getBlob, putBlob } from "../blobs";
import { now } from "../clock";
import { AppError, defer, envBaseUrl, type Ctx } from "../context";
import { decrypt, sha256Hex } from "../crypto";
import { getDb, type DbOrTx, type Tx } from "../db";
import { envelopes, files, signers, workspaces, type Envelope, type FileRow, type Signer, type Workspace } from "../db/schema";
import { sendEmail } from "../email";
import { finalizePdf } from "../pdf/finalize";
import { emitWebhook } from "../webhooks";
import { filePayload, resolveAutoFields, signingUrl } from "./files";
import { getTemplate } from "./templates";

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  baseUrl?: string;
}

async function load(db: DbOrTx, token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [signer] = await db.select().from(signers).where(eq(signers.tokenHash, sha256Hex(token))).limit(1);
  if (!signer) return null;
  const [envelope] = await db.select().from(envelopes).where(eq(envelopes.id, signer.envelopeId)).limit(1);
  const [file] = await db.select().from(files).where(eq(files.id, envelope.fileId)).limit(1);
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, envelope.workspaceId)).limit(1);
  const everyone = await db.select().from(signers).where(eq(signers.envelopeId, envelope.id));
  return { signer, envelope, file, workspace, everyone };
}

export type SigningState = "sign" | "waiting" | "completed" | "declined" | "voided" | "expired";

function stateOf(signer: Signer, envelope: Envelope): SigningState {
  if (envelope.status === "completed") return "completed";
  if (envelope.status === "voided") return "voided";
  if (envelope.status === "declined") return "declined";
  if (envelope.status === "expired" || (envelope.expiresAt && envelope.expiresAt < now())) return "expired";
  if (signer.status === "signed") return "waiting";
  return "sign";
}

export interface SigningField extends EnvelopeField {
  /** True when the person holding this link fills the field. */
  mine: boolean;
}

/** Everything the signing page needs, and nothing a signer should not see. */
export async function getSigningView(token: string) {
  const db = await getDb();
  const found = await load(db, token);
  if (!found) return null;
  const { signer, envelope, file, workspace, everyone } = found;
  const others: Record<string, FieldValue> = {};
  for (const s of everyone) if (s.id !== signer.id && s.status === "signed") Object.assign(others, s.values);

  const fields: SigningField[] = envelope.fields.map((f) => {
    if (f.assignee === AUTO) return { ...f, mine: false };
    if (f.assignee === signer.roleKey) return { ...f, mine: true, value: signer.values[f.id] };
    return { ...f, mine: false, value: others[f.id] };
  });

  return {
    state: stateOf(signer, envelope),
    firm: { name: workspace.name, brandColor: workspace.brandColor },
    file: { reference: file.reference, title: file.title },
    agreement: {
      name: envelope.templateName,
      docId: envelope.docId,
      pages: envelope.pages,
      sentAt: envelope.sentAt.toISOString(),
      completedAt: envelope.completedAt?.toISOString() ?? null,
    },
    signer: { name: signer.name, email: signer.email, roleLabel: signer.roleLabel, consented: Boolean(signer.consentedAt) },
    others: everyone.filter((s) => s.id !== signer.id).map((s) => ({ name: s.name, roleLabel: s.roleLabel, signed: s.status === "signed" })),
    declineReason: everyone.find((s) => s.status === "declined")?.declineReason ?? null,
    fields,
  };
}
export type SigningView = NonNullable<Awaited<ReturnType<typeof getSigningView>>>;

/**
 * The view a client would get for a template, built from sample data and written nowhere.
 * It goes through the same automatic-field resolver as a real send.
 */
export async function getPreviewView(ctx: Ctx, templateId: string): Promise<SigningView | null> {
  const db = await getDb();
  const template = await getTemplate(db, ctx.workspaceId, templateId);
  if (!template || template.status === "archived") return null;
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1);
  const role = template.roles[0] ?? { key: "client", label: "Client" };
  const sample = { name: "Sample Client", email: "client@example.com" };
  const known: Record<string, string> = {
    ...Object.fromEntries(template.variables.map((v) => [v.key, `[${v.label}]`])),
    client_name: sample.name,
    client_email: sample.email,
    file_reference: "F-0000",
    file_title: "Sample file",
    sent_date: longDate(now(), { ...DEFAULT_SETTINGS, ...workspace.settings }.timeZone),
    firm_name: workspace.name,
    firm_signer_name: workspace.firmSigner?.name ?? "",
    firm_signer_title: workspace.firmSigner?.title ?? "",
  };
  const { fields } = resolveAutoFields(template.fields, known, workspace.firmSigner);
  return {
    state: "sign",
    firm: { name: workspace.name, brandColor: workspace.brandColor },
    file: { reference: "F-0000", title: "Sample file" },
    agreement: { name: template.name, docId: "PREVIEW", pages: template.pages, sentAt: now().toISOString(), completedAt: null },
    signer: { name: sample.name, email: sample.email, roleLabel: role.label, consented: false },
    others: template.roles.slice(1).map((r) => ({ name: r.label, roleLabel: r.label, signed: false })),
    declineReason: null,
    fields: fields.map((f) => ({ ...f, mine: f.assignee === role.key })),
  };
}

export async function signingDocument(token: string, which: "source" | "signed") {
  const db = await getDb();
  const found = await load(db, token);
  if (!found || found.envelope.status === "voided") return null;
  const blobId = which === "signed" ? found.envelope.signedBlobId : found.envelope.sourceBlobId;
  if (!blobId) return null;
  return { db, workspaceId: found.envelope.workspaceId, blobId, envelope: found.envelope, file: found.file };
}

/** Lock the envelope, then re-read the signer inside the lock. */
async function lockForSigner(tx: Tx, token: string) {
  const found = await load(tx, token);
  if (!found) throw new AppError("This signing link is not valid.", "not_found", 404);
  const [envelope] = await tx.select().from(envelopes).where(eq(envelopes.id, found.envelope.id)).for("update");
  const everyone = await tx.select().from(signers).where(eq(signers.envelopeId, envelope.id));
  const signer = everyone.find((s) => s.id === found.signer.id)!;
  return { ...found, envelope, everyone, signer };
}

export async function recordView(token: string, meta: RequestMeta) {
  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    const { signer, envelope, file, everyone } = await lockForSigner(tx, token);
    if (signer.viewedAt || stateOf(signer, envelope) !== "sign") return null;
    const at = now();
    await tx.update(signers).set({ viewedAt: at, status: "viewed", ip: meta.ip ?? null, userAgent: meta.userAgent ?? null }).where(eq(signers.id, signer.id));
    await appendEvent(tx, {
      workspaceId: envelope.workspaceId,
      envelopeId: envelope.id,
      fileId: file.id,
      type: "agreement.viewed",
      actor: { kind: "signer", name: signer.name, email: signer.email },
      ip: meta.ip,
      userAgent: meta.userAgent,
      at,
    });
    return { envelope, file, everyone: everyone.map((s) => (s.id === signer.id ? { ...s, status: "viewed" as const, viewedAt: at } : s)) };
  });
  if (result) {
    defer(() => emitWebhook(db, result.envelope.workspaceId, "agreement.viewed", filePayload(result.file, result.envelope, result.everyone, meta.baseUrl ?? envBaseUrl())));
  }
}

/** The signer agreed to do business electronically. Recorded once, before any field is filled. */
export async function recordConsent(token: string, meta: RequestMeta) {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const { signer, envelope, file } = await lockForSigner(tx, token);
    if (signer.consentedAt || stateOf(signer, envelope) !== "sign") return;
    await consent(tx, signer, envelope, file, meta, now());
  });
}

async function consent(tx: Tx, signer: Signer, envelope: Envelope, file: FileRow, meta: RequestMeta, at: Date) {
  await tx.update(signers).set({ consentedAt: at }).where(eq(signers.id, signer.id));
  await appendEvent(tx, {
    workspaceId: envelope.workspaceId,
    envelopeId: envelope.id,
    fileId: file.id,
    type: "agreement.consented",
    actor: { kind: "signer", name: signer.name, email: signer.email },
    ip: meta.ip,
    userAgent: meta.userAgent,
    at,
    data: { disclosure: "Electronic records and signatures (ESIGN Act, UETA)" },
  });
}

const submitSchema = z.object({
  consent: z.literal(true, { errorMap: () => ({ message: "You must agree to sign electronically." }) }),
  timeZone: z.string().max(64).optional(),
  values: z.record(z.union([z.string().max(500), z.boolean(), signatureValueSchema])),
});

function isSignature(v: unknown): v is SignatureValue {
  return typeof v === "object" && v !== null && "kind" in v;
}

/**
 * Accept a signer's completed fields. Everything is validated against the envelope's own
 * field snapshot: a signer can only write fields assigned to their role, required fields
 * must be present, and the signing date is set by the server, not the browser.
 */
export async function submitSigning(token: string, raw: unknown, meta: RequestMeta) {
  const input = submitSchema.parse(raw);
  const db = await getDb();
  const baseUrl = meta.baseUrl ?? envBaseUrl();

  const result = await db.transaction(async (tx) => {
    const { signer, envelope, file, workspace, everyone } = await lockForSigner(tx, token);
    const state = stateOf(signer, envelope);
    if (state === "completed" || state === "waiting") throw new AppError("You have already signed this agreement.", "already_signed", 409);
    if (state !== "sign") throw new AppError("This agreement can no longer be signed.", state, 410);

    const at = now();
    const timeZone = isValidTimeZone(input.timeZone) ? input.timeZone : { ...DEFAULT_SETTINGS, ...workspace.settings }.timeZone;
    const values: Record<string, FieldValue> = {};
    let signatureKind = "";
    for (const field of envelope.fields) {
      if (field.assignee !== signer.roleKey) continue;
      const v = input.values[field.id];
      switch (field.type) {
        case "signature":
        case "initials":
          if (isSignature(v)) {
            if (v.kind === "drawn" && inkLength(v.strokes) < 12) throw new AppError("That signature is too small to count. Please sign again.", "invalid_signature", 422);
            values[field.id] = v;
            if (field.type === "signature") signatureKind = v.kind;
          } else if (field.required) throw new AppError("A required signature is missing.", "missing_field", 422);
          break;
        case "date":
          values[field.id] = longDate(at, timeZone);
          break;
        case "checkbox":
          if (v === true) values[field.id] = true;
          else if (field.required) throw new AppError("A required checkbox is not ticked.", "missing_field", 422);
          break;
        default: {
          const text = typeof v === "string" ? v.trim() : "";
          if (text) values[field.id] = text.slice(0, 500);
          else if (field.required) throw new AppError(`"${field.label ?? (field.type === "name" ? "Full name" : "A required field")}" is missing.`, "missing_field", 422);
        }
      }
    }

    if (!signer.consentedAt) await consent(tx, signer, envelope, file, meta, at);
    await tx
      .update(signers)
      .set({ status: "signed", signedAt: at, values, ip: meta.ip ?? signer.ip, userAgent: meta.userAgent ?? signer.userAgent, viewedAt: signer.viewedAt ?? at })
      .where(eq(signers.id, signer.id));
    await appendEvent(tx, {
      workspaceId: envelope.workspaceId,
      envelopeId: envelope.id,
      fileId: file.id,
      type: "agreement.signed",
      actor: { kind: "signer", name: signer.name, email: signer.email },
      ip: meta.ip,
      userAgent: meta.userAgent,
      at,
      data: { role: signer.roleLabel, fields: Object.keys(values).length, signature: signatureKind || "none", timeZone },
    });

    const updated = everyone.map((s) =>
      s.id === signer.id
        ? { ...s, status: "signed" as const, signedAt: at, values, consentedAt: s.consentedAt ?? at, viewedAt: s.viewedAt ?? at, ip: meta.ip ?? s.ip, userAgent: meta.userAgent ?? s.userAgent }
        : s,
    );
    const done = updated.every((s) => s.status === "signed");
    let finalEnvelope: Envelope = { ...envelope, status: done ? "completed" : "partially_signed" };
    if (done) finalEnvelope = await complete(tx, envelope, file, workspace, updated, baseUrl);
    else await tx.update(envelopes).set({ status: "partially_signed" }).where(eq(envelopes.id, envelope.id));

    return { done, envelope: finalEnvelope, file: done ? { ...file, status: "signed" as const } : file, workspace, everyone: updated, signer };
  });

  defer(() => afterSigned(db, result, baseUrl));
  return { status: result.done ? ("completed" as const) : ("waiting" as const) };
}

/** Stamp the PDF, append the certificate, store the record and release the file. */
async function complete(tx: Tx, envelope: Envelope, file: FileRow, workspace: Workspace, everyone: Signer[], baseUrl: string): Promise<Envelope> {
  const source = await getBlob(tx, envelope.workspaceId, envelope.sourceBlobId);
  if (!source) throw new AppError("The original document is missing.", "not_found", 500);
  const completedAt = now();
  const trail = await envelopeEvents(tx, envelope.id);
  if (!verifyChain(trail).ok) throw new AppError("The audit trail failed its integrity check. The agreement was not completed.", "audit_broken", 500);

  const values: Record<string, FieldValue> = {};
  for (const s of everyone) Object.assign(values, s.values);
  const firstSignature = (s: Signer) => {
    const field = envelope.fields.find((f) => f.assignee === s.roleKey && f.type === "signature");
    const v = field ? s.values[field.id] : undefined;
    return isSignature(v) ? v : null;
  };
  const firmSigned = envelope.fields.some((f) => f.assignee === AUTO && f.type === "signature");

  const pdf = await finalizePdf({
    source: source.data,
    fields: envelope.fields,
    values,
    certificate: {
      workspaceName: workspace.name,
      fileReference: file.reference,
      fileTitle: file.title,
      templateName: envelope.templateName,
      templateVersion: envelope.templateVersion,
      docId: envelope.docId,
      sourceSha256: envelope.sourceSha256,
      sentAt: envelope.sentAt,
      completedAt,
      pageCount: envelope.pages.length,
      signers: everyone.map((s) => ({
        name: s.name,
        email: s.email,
        roleLabel: s.roleLabel,
        viewedAt: s.viewedAt,
        consentedAt: s.consentedAt,
        signedAt: s.signedAt,
        ip: s.ip,
        userAgent: s.userAgent,
        signature: firstSignature(s),
      })),
      firmSigner: firmSigned ? workspace.firmSigner : null,
      events: [
        ...trail.map((e) => ({ at: e.createdAt, type: e.type, actor: e.actor.name, ip: e.ip })),
        { at: completedAt, type: "agreement.completed", actor: "Onfile", ip: null },
      ],
      auditHead: trail[trail.length - 1]?.hash ?? "",
      verifyUrl: `${baseUrl}/verify?id=${envelope.docId}`,
    },
  });

  const stored = await putBlob(tx, envelope.workspaceId, pdf, "application/pdf");
  await tx
    .update(envelopes)
    .set({ status: "completed", completedAt, signedBlobId: stored.id, signedSha256: stored.sha256 })
    .where(eq(envelopes.id, envelope.id));
  await tx.update(files).set({ status: "signed", updatedAt: completedAt }).where(eq(files.id, file.id));
  await appendEvent(tx, {
    workspaceId: envelope.workspaceId,
    envelopeId: envelope.id,
    fileId: file.id,
    type: "agreement.completed",
    actor: { kind: "system", name: "Onfile" },
    at: completedAt,
    data: { signedSha256: stored.sha256, bytes: stored.size },
  });
  return { ...envelope, status: "completed", completedAt, signedBlobId: stored.id, signedSha256: stored.sha256 };
}

async function afterSigned(
  db: DbOrTx,
  r: { done: boolean; envelope: Envelope; file: FileRow; workspace: Workspace; everyone: Signer[]; signer: Signer },
  baseUrl: string,
) {
  const { workspace: ws, file, envelope } = r;
  const settings = { ...DEFAULT_SETTINGS, ...ws.settings };
  const payload = filePayload(file, envelope, r.everyone, baseUrl);
  await emitWebhook(db, ws.id, "agreement.signed", { ...payload, signer: { name: r.signer.name, email: r.signer.email, role: r.signer.roleKey } });
  if (!r.done) return;

  await emitWebhook(db, ws.id, "agreement.completed", payload);
  for (const s of r.everyone) {
    await sendEmail(db, {
      workspaceId: ws.id,
      envelopeId: envelope.id,
      fileId: file.id,
      kind: "completed",
      to: s.email,
      toName: s.name,
      fromName: ws.name,
      replyTo: settings.replyTo || undefined,
      subject: `Signed: your ${envelope.templateName} with ${ws.name}`,
      content: {
        firmName: ws.name,
        brandColor: ws.brandColor,
        heading: "Your signed copy is ready",
        paragraphs: [
          `Hello ${s.name.split(" ")[0]},`,
          `Everyone has signed the ${envelope.templateName}. ${ws.name} can now begin work on your file. Keep the signed copy for your records.`,
        ],
        details: [
          ["File", file.reference],
          ["Document ID", envelope.docId],
        ],
        cta: { label: "Download signed copy", url: signingUrl(baseUrl, decrypt(s.tokenEnc)) },
      },
    });
  }
  const notify = settings.notifyEmail || file.createdByEmail;
  if (notify) {
    await sendEmail(db, {
      workspaceId: ws.id,
      envelopeId: envelope.id,
      fileId: file.id,
      kind: "firm_notice",
      to: notify,
      fromName: "Onfile",
      subject: `Signed: ${file.clientName} (${file.reference}) is cleared to start`,
      content: {
        firmName: ws.name,
        brandColor: ws.brandColor,
        heading: `${file.clientName} signed`,
        paragraphs: [`The ${envelope.templateName} for file ${file.reference} is fully signed. The file is cleared to start.`],
        cta: { label: "Open file", url: `${baseUrl}/files/${file.id}` },
      },
    });
  }
}

export async function declineSigning(token: string, reason: string, meta: RequestMeta) {
  const db = await getDb();
  const baseUrl = meta.baseUrl ?? envBaseUrl();
  const result = await db.transaction(async (tx) => {
    const { signer, envelope, file, workspace, everyone } = await lockForSigner(tx, token);
    if (stateOf(signer, envelope) !== "sign") throw new AppError("This agreement can no longer be declined.", "conflict", 409);
    const at = now();
    const clean = reason.trim().slice(0, 500);
    await tx.update(signers).set({ status: "declined", declinedAt: at, declineReason: clean, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null }).where(eq(signers.id, signer.id));
    await tx.update(envelopes).set({ status: "declined" }).where(eq(envelopes.id, envelope.id));
    await tx.update(files).set({ status: "declined", updatedAt: at }).where(eq(files.id, file.id));
    await appendEvent(tx, {
      workspaceId: envelope.workspaceId,
      envelopeId: envelope.id,
      fileId: file.id,
      type: "agreement.declined",
      actor: { kind: "signer", name: signer.name, email: signer.email },
      ip: meta.ip,
      userAgent: meta.userAgent,
      at,
      data: { reason: clean },
    });
    return {
      envelope: { ...envelope, status: "declined" as const },
      file: { ...file, status: "declined" as const },
      workspace,
      signer,
      reason: clean,
      everyone: everyone.map((s) => (s.id === signer.id ? { ...s, status: "declined" as const } : s)),
    };
  });

  defer(async () => {
    const { workspace: ws, file, envelope } = result;
    await emitWebhook(db, ws.id, "agreement.declined", { ...filePayload(file, envelope, result.everyone, baseUrl), reason: result.reason });
    const notify = { ...DEFAULT_SETTINGS, ...ws.settings }.notifyEmail || file.createdByEmail;
    if (notify) {
      await sendEmail(db, {
        workspaceId: ws.id,
        envelopeId: envelope.id,
        fileId: file.id,
        kind: "firm_notice",
        to: notify,
        fromName: "Onfile",
        subject: `Declined: ${file.clientName} (${file.reference}) did not sign`,
        content: {
          firmName: ws.name,
          brandColor: ws.brandColor,
          heading: `${result.signer.name} declined to sign`,
          paragraphs: [`The ${envelope.templateName} for file ${file.reference} was declined. The file stays blocked until a new agreement is signed.`],
          note: result.reason || undefined,
          cta: { label: "Open file", url: `${baseUrl}/files/${file.id}` },
        },
      });
    }
  });
}

/** Public verification: match a document id or a file fingerprint against the registry. */
export async function verifyDocument(query: { docId?: string; sha256?: string }) {
  const db = await getDb();
  let envelope: Envelope | undefined;
  if (query.sha256 && /^[a-f0-9]{64}$/.test(query.sha256)) {
    [envelope] = await db.select().from(envelopes).where(eq(envelopes.signedSha256, query.sha256)).limit(1);
    if (!envelope) return { found: false as const, reason: "no_match" as const };
  } else if (query.docId) {
    [envelope] = await db.select().from(envelopes).where(eq(envelopes.docId, query.docId.trim().toUpperCase())).limit(1);
    if (!envelope) return { found: false as const, reason: "unknown_id" as const };
  } else return { found: false as const, reason: "empty" as const };

  const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, envelope.workspaceId));
  const people = await db.select().from(signers).where(and(eq(signers.envelopeId, envelope.id)));
  const chain = verifyChain(await envelopeEvents(db, envelope.id));
  return {
    found: true as const,
    matchedBy: query.sha256 ? ("fingerprint" as const) : ("id" as const),
    docId: envelope.docId,
    status: envelope.status,
    firm: ws?.name ?? "",
    agreement: envelope.templateName,
    sentAt: envelope.sentAt,
    completedAt: envelope.completedAt,
    signedSha256: envelope.signedSha256,
    auditIntact: chain.ok,
    signers: people.map((p) => ({ name: p.name, email: p.email, role: p.roleLabel, signedAt: p.signedAt })),
  };
}
