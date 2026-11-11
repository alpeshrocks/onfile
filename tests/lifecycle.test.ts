import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { syntheticSignature } from "@/lib/signature";
import type { FieldValue } from "@/lib/types";
import { envelopeEvents, verifyChain } from "@/server/audit";
import { getBlob } from "@/server/blobs";
import { withClock } from "@/server/clock";
import { flushDeferred, type Ctx } from "@/server/context";
import { sha256Hex } from "@/server/crypto";
import { getDb, resetDb } from "@/server/db";
import { emails, events, envelopes } from "@/server/db/schema";
import { setFirmSigner, signup } from "@/server/services/accounts";
import { runAutomation } from "@/server/services/automation";
import { buildSampleAgreement, createDemoWorkspace } from "@/server/services/demo";
import { createFile, dashboard, getFile, listFiles, resendAgreement, voidAgreement } from "@/server/services/files";
import { declineSigning, getSigningView, recordConsent, recordView, submitSigning, verifyDocument } from "@/server/services/signing";
import { addSignaturePage, ingestDocument, saveTemplate } from "@/server/services/templates";

/**
 * End to end through the real services against a real (in-memory) Postgres:
 * upload an agreement the system has never seen, publish it, open a file, sign, verify.
 */

const BASE = "http://localhost:3000";
const meta = { ip: "198.51.100.7", userAgent: "vitest", baseUrl: BASE };
let ctx: Ctx;
let other: Ctx;

async function workspace(company: string, email: string): Promise<Ctx> {
  const a = await signup({ name: "Test Owner", company, email, password: "correct horse battery" });
  return { workspaceId: a.workspaceId, userId: a.userId, actor: { kind: "user", name: "Test Owner", email }, baseUrl: BASE };
}

function fill(fields: { id: string; type: string; assignee: string }[], role: string, name: string) {
  const values: Record<string, FieldValue> = {};
  for (const f of fields) {
    if (f.assignee !== role) continue;
    if (f.type === "signature" || f.type === "initials") values[f.id] = syntheticSignature(name);
    else if (f.type === "name") values[f.id] = name;
    else if (f.type === "checkbox") values[f.id] = true;
    else if (f.type === "text") values[f.id] = "Sample";
  }
  return values;
}

async function publishedTemplate(c: Ctx) {
  const pdf = await buildSampleAgreement("Acme Adjusters");
  const { id } = await ingestDocument(c, { bytes: pdf.bytes, filename: "client-agreement.pdf" });
  await setFirmSigner(c, { name: "Riley Stone", title: "Principal", signature: syntheticSignature("Riley Stone") });
  return saveTemplate(c, id, { fields: pdf.fields }, { publish: true });
}

beforeAll(async () => {
  await resetDb();
  ctx = await workspace("Acme Adjusters", "owner@acme.test");
  other = await workspace("Rival Firm", "owner@rival.test");
});

describe("agreement lifecycle", () => {
  it("refuses to publish an agreement nobody can sign", async () => {
    const { id } = await ingestDocument(ctx, { bytes: new TextEncoder().encode("# Terms\n\nThe client agrees to the terms."), filename: "terms.txt" });
    await expect(saveTemplate(ctx, id, {}, { publish: true })).rejects.toThrow(/signature/i);
    // One click fixes it: Onfile appends a signature page with fields already placed.
    const withPage = await addSignaturePage(ctx, id, { includeFirm: false });
    expect(withPage.pages).toHaveLength(2);
    const published = await saveTemplate(ctx, id, {}, { publish: true });
    expect(published.status).toBe("active");
    expect(published.version).toBe(1);
  });

  it("sends on file creation, collects the signature and produces a verifiable record", async () => {
    const template = await publishedTemplate(ctx);
    const created = await createFile(ctx, {
      title: "Kitchen water damage",
      templateId: template.id,
      signers: [{ role: "client", name: "Łukasz Żółć", email: "Client@Example.com" }],
    });
    await flushDeferred();
    expect(created.file.reference).toMatch(/^F-\d{4}$/);
    expect(created.file.status).toBe("awaiting_signature");
    const token = (created.signers[0] as { token: string }).token;

    const db = await getDb();
    const outbox = await db.select().from(emails).where(eq(emails.fileId, created.file.id));
    expect(outbox).toHaveLength(1);
    expect(outbox[0].toEmail).toBe("client@example.com");
    expect(outbox[0].html).toContain(`/sign/${token}`);

    // The signer sees the firm's values but can only fill their own fields.
    const view = (await getSigningView(token))!;
    expect(view.state).toBe("sign");
    expect(view.fields.filter((f) => f.mine).every((f) => f.assignee === "client")).toBe(true);
    expect(view.fields.find((f) => f.assignee === "auto" && f.type === "signature")?.value).toBeTruthy();

    await recordView(token, meta);
    await recordConsent(token, meta);
    await expect(submitSigning(token, { consent: true, values: {} }, meta)).rejects.toThrow(/missing/i);
    // A signer cannot write fields that belong to the firm.
    const firmField = created.envelope!.fields.find((f) => f.assignee === "auto" && f.type === "text")!;
    const result = await submitSigning(
      token,
      { consent: true, timeZone: "America/Chicago", values: { ...fill(created.envelope!.fields, "client", "Łukasz Żółć"), [firmField.id]: "forged" } },
      meta,
    );
    await flushDeferred();
    expect(result.status).toBe("completed");
    await expect(submitSigning(token, { consent: true, values: {} }, meta)).rejects.toThrow(/already signed/i);

    const detail = (await getFile(ctx, created.file.id))!;
    const envelope = detail.envelopes[0];
    expect(detail.file.status).toBe("signed");
    expect(envelope.status).toBe("completed");
    expect(envelope.fields.find((f) => f.id === firmField.id)?.value).not.toBe("forged");

    // The stored PDF is the original pages plus a certificate, and its hash is registered.
    const blob = (await getBlob(db, ctx.workspaceId, envelope.signedBlobId!))!;
    expect(sha256Hex(blob.data)).toBe(envelope.signedSha256);
    const signed = await PDFDocument.load(blob.data);
    expect(signed.getPageCount()).toBeGreaterThan(envelope.pages.length);
    // Optional: ONFILE_DUMP=/some/dir keeps the signed PDF for a visual check.
    if (process.env.ONFILE_DUMP) writeFileSync(join(process.env.ONFILE_DUMP, "signed.pdf"), blob.data);

    const trail = await envelopeEvents(db, envelope.id);
    expect(trail.map((e) => e.type)).toEqual([
      "agreement.sent",
      "agreement.firm_signed",
      "agreement.viewed",
      "agreement.consented",
      "agreement.signed",
      "agreement.completed",
    ]);
    expect(verifyChain(trail).ok).toBe(true);

    const byHash = await verifyDocument({ sha256: envelope.signedSha256! });
    expect(byHash.found && byHash.auditIntact).toBe(true);
    const tampered = await verifyDocument({ sha256: sha256Hex("not the document") });
    expect(tampered.found).toBe(false);

    // Signed copy and firm notice both went out.
    const after = await db.select().from(emails).where(eq(emails.fileId, created.file.id));
    expect(after.map((e) => e.kind).sort()).toEqual(["completed", "firm_notice", "signature_request"]);
  });

  it("detects tampering with the audit trail", async () => {
    const db = await getDb();
    const [envelope] = await db.select().from(envelopes).where(eq(envelopes.status, "completed")).limit(1);
    const trail = await envelopeEvents(db, envelope.id);
    await db.update(events).set({ ip: "10.0.0.1" }).where(eq(events.id, trail[2].id));
    const check = await verifyDocument({ docId: envelope.docId });
    expect(check.found && check.auditIntact).toBe(false);
  });

  it("is idempotent for integrations and isolated between tenants", async () => {
    const input = { externalId: "crm-991", signers: [{ role: "client", name: "Pat Lee", email: "pat@example.com" }] };
    const first = await createFile(ctx, input);
    const second = await createFile(ctx, input);
    await flushDeferred();
    expect(second.existing).toBe(true);
    expect(second.file.id).toBe(first.file.id);

    expect(await getFile(other, first.file.id)).toBeNull();
    expect(await listFiles(other)).toHaveLength(0);
    await expect(voidAgreement(other, first.envelope!.id, "nope")).rejects.toThrow(/not found/i);
    // A workspace with no published agreement gets a clear instruction, not a crash.
    await expect(createFile(other, { signers: [{ role: "client", name: "A", email: "a@example.com" }] })).rejects.toThrow(/publish an agreement/i);
  });

  it("handles decline, then a fresh agreement on the same file", async () => {
    const created = await createFile(ctx, { signers: [{ role: "client", name: "Sam Ortiz", email: "sam@example.com" }] });
    const token = (created.signers[0] as { token: string }).token;
    await declineSigning(token, "Fee is too high", meta);
    await flushDeferred();
    expect((await getFile(ctx, created.file.id))!.file.status).toBe("declined");
    expect((await getSigningView(token))!.state).toBe("declined");

    await resendAgreement(ctx, created.file.id);
    await flushDeferred();
    const detail = (await getFile(ctx, created.file.id))!;
    expect(detail.file.status).toBe("awaiting_signature");
    expect(detail.envelopes).toHaveLength(2);
  });

  it("sends reminders on schedule, never twice, and expires stale requests", async () => {
    const c = await workspace("Clockwork LLC", "owner@clock.test");
    await publishedTemplate(c);
    const t0 = new Date("2026-03-02T15:00:00Z");
    const created = await withClock(t0, () => createFile(c, { signers: [{ role: "client", name: "Kai Moss", email: "kai@example.com" }] }));
    await flushDeferred();
    const day = (n: number) => new Date(t0.getTime() + n * 86_400_000 + 60_000);

    expect((await withClock(day(1), () => runAutomation(BASE, c.workspaceId))).reminded).toBe(0);
    expect((await withClock(day(2), () => runAutomation(BASE, c.workspaceId))).reminded).toBe(1);
    expect((await withClock(day(2), () => runAutomation(BASE, c.workspaceId))).reminded).toBe(0);
    expect((await withClock(day(5), () => runAutomation(BASE, c.workspaceId))).reminded).toBe(1);

    const expired = await withClock(day(31), () => runAutomation(BASE, c.workspaceId));
    expect(expired.expired).toBe(1);
    const token = (created.signers[0] as { token: string }).token;
    expect((await getSigningView(token))!.state).toBe("expired");
    await expect(submitSigning(token, { consent: true, values: {} }, meta)).rejects.toThrow(/no longer/i);
  });

  it("waits for every signer when an agreement has a co-signer", async () => {
    const c = await workspace("Twofold LLC", "owner@twofold.test");
    const pdf = await buildSampleAgreement("Twofold LLC");
    const { id } = await ingestDocument(c, { bytes: pdf.bytes, filename: "joint.pdf" });
    await setFirmSigner(c, { name: "Riley Stone", title: "Principal", signature: syntheticSignature("Riley Stone") });
    const roles = [
      { key: "client", label: "Client" },
      { key: "client2", label: "Co-owner" },
    ];
    const extra = pdf.fields.filter((f) => f.assignee === "client").map((f) => ({ ...f, id: `${f.id}_b`, assignee: "client2", y: f.y + 0.4 }));
    await saveTemplate(c, id, { roles, fields: [...pdf.fields, ...extra] }, { publish: true });

    await expect(createFile(c, { signers: [{ role: "client", name: "Ana Diaz", email: "ana@example.com" }] })).rejects.toThrow(/Co-owner/);
    const created = await createFile(c, {
      signers: [
        { role: "client", name: "Ana Diaz", email: "ana@example.com" },
        { role: "client2", name: "Luis Diaz", email: "luis@example.com" },
      ],
    });
    const [ana, luis] = created.signers as { token: string }[];
    const fields = created.envelope!.fields;

    const first = await submitSigning(ana.token, { consent: true, values: fill(fields, "client", "Ana Diaz") }, meta);
    expect(first.status).toBe("waiting");
    expect((await getFile(c, created.file.id))!.file.status).toBe("awaiting_signature");
    expect((await getSigningView(ana.token))!.state).toBe("waiting");
    // The second signer sees what the first one signed, but cannot change it.
    const luisView = (await getSigningView(luis.token))!;
    expect(luisView.fields.filter((f) => f.mine).every((f) => f.assignee === "client2")).toBe(true);
    expect(luisView.fields.find((f) => f.assignee === "client" && f.type === "signature")?.value).toBeTruthy();

    const second = await submitSigning(luis.token, { consent: true, values: fill(fields, "client2", "Luis Diaz") }, meta);
    await flushDeferred();
    expect(second.status).toBe("completed");
    expect((await getFile(c, created.file.id))!.file.status).toBe("signed");
  });

  it("accepts Word documents, plain text and images, and explains what it cannot read", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    const para = (t: string, bold = false) => `<w:p><w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
    zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${para("Retainer Agreement", true)}${para("The Client retains the Firm. Żółć and naïve café are spelled correctly.")}${para("Client Signature: ______________________________")}</w:body></w:document>`);
    const docx = await zip.generateAsync({ type: "uint8array" });

    const word = await ingestDocument(ctx, { bytes: docx, filename: "Retainer Agreement.docx" });
    expect(word.converted).toBe(true);
    expect(word.pageCount).toBe(1);
    // The converted PDF keeps its text, so detection still works on it.
    const db = await getDb();
    const { templates } = await import("@/server/db/schema");
    const [row] = await db.select().from(templates).where(eq(templates.id, word.id));
    const blob = (await getBlob(db, ctx.workspaceId, row.blobId))!;
    const { extract } = await import("./helpers/pdf");
    const { detectFields } = await import("@/lib/detect");
    const found = detectFields((await extract(blob.data)).pages);
    expect(found.fields.map((f) => f.type)).toEqual(["signature"]);
    expect(row.name).toBe("Retainer Agreement");

    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    expect((await ingestDocument(ctx, { bytes: png, filename: "scan.png" })).converted).toBe(true);
    expect((await ingestDocument(ctx, { bytes: new TextEncoder().encode("Plain terms.\n\nSignature: __________"), filename: "terms.txt" })).converted).toBe(true);

    await expect(ingestDocument(ctx, { bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]), filename: "old.doc" })).rejects.toThrow(/\.doc files are not supported/);
    await expect(ingestDocument(ctx, { bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), filename: "mystery.bin" })).rejects.toThrow(/Upload a PDF/);
    await expect(ingestDocument(ctx, { bytes: new TextEncoder().encode("%PDF-1.7 this is not really a pdf"), filename: "broken.pdf" })).rejects.toThrow(/could not be read/);
    await expect(ingestDocument(ctx, { bytes: new Uint8Array(0), filename: "empty.pdf" })).rejects.toThrow(/empty/);
  });

  it("seeds a demo workspace through the real code path with an intact audit chain", async () => {
    const demo = await createDemoWorkspace(BASE, "America/Los_Angeles");
    const d: Ctx = { workspaceId: demo.workspaceId, actor: { kind: "user", name: "Demo" }, baseUrl: BASE };
    const stats = await dashboard(d);
    expect(stats.total).toBe(7);
    expect(stats.signed).toBe(3);
    expect(stats.awaiting).toBe(3);
    expect(stats.medianMs).toBeGreaterThan(0);

    const db = await getDb();
    const done = await db.select().from(envelopes).where(eq(envelopes.workspaceId, demo.workspaceId));
    for (const e of done) expect(verifyChain(await envelopeEvents(db, e.id)).ok).toBe(true);
  });
});
