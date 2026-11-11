import { count, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { syntheticSignature } from "@/lib/signature";
import type { FieldValue } from "@/lib/types";
import { envelopeEvents, verifyChain } from "@/server/audit";
import { flushDeferred, type Ctx } from "@/server/context";
import { getDb, resetDb } from "@/server/db";
import { emails, envelopes, files, passwordResets } from "@/server/db/schema";
import {
  acceptInvite,
  createInvite,
  createResetLink,
  findReset,
  listMembers,
  login,
  removeMember,
  requestPasswordReset,
  resetPassword,
  sessionFromToken,
  setFirmSigner,
  signup,
} from "@/server/services/accounts";
import { buildSampleAgreement } from "@/server/services/demo";
import { createFile, getFile, updateSigner } from "@/server/services/files";
import { getPreviewView, getSigningView, submitSigning } from "@/server/services/signing";
import { ingestDocument, saveTemplate } from "@/server/services/templates";

const BASE = "http://localhost:3000";
const meta = { ip: "198.51.100.7", userAgent: "vitest", baseUrl: BASE };
let ctx: Ctx;
let ownerSession: string;
let templateId: string;

const tokenOf = (url: string) => url.split("/").pop()!;

async function workspace(company: string, email: string) {
  const a = await signup({ name: "Owner Person", company, email, password: "correct horse battery" });
  const c: Ctx = { workspaceId: a.workspaceId, userId: a.userId, actor: { kind: "user", name: "Owner Person", email }, baseUrl: BASE };
  return { ctx: c, session: a.token };
}

function fill(fields: { id: string; type: string; assignee: string }[], role: string, name: string) {
  const values: Record<string, FieldValue> = {};
  for (const f of fields) {
    if (f.assignee !== role) continue;
    if (f.type === "signature") values[f.id] = syntheticSignature(name);
    else if (f.type === "name") values[f.id] = name;
  }
  return values;
}

beforeAll(async () => {
  await resetDb();
  const w = await workspace("Acme Adjusters", "owner@acme.test");
  ctx = w.ctx;
  ownerSession = w.session;
  const pdf = await buildSampleAgreement("Acme Adjusters");
  const { id } = await ingestDocument(ctx, { bytes: pdf.bytes, filename: "agreement.pdf" });
  await setFirmSigner(ctx, { name: "Riley Stone", title: "Principal", signature: syntheticSignature("Riley Stone") });
  // Print the client's name on the agreement, so a correction has something to update.
  const printed = { ...pdf.fields.find((f) => f.type === "date" && f.assignee === "auto")!, id: "printed_client", type: "text" as const, variable: "client_name", y: 0.9 };
  await saveTemplate(ctx, id, { fields: [...pdf.fields, printed] }, { publish: true });
  templateId = id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("correcting a signer after sending", () => {
  it("revokes the old link, issues a new one, updates the file and records the change", async () => {
    const created = await createFile(ctx, { signers: [{ role: "client", name: "Jordon Avery", email: "jordon@exmaple.com" }] });
    await flushDeferred();
    const oldToken = (created.signers[0] as { token: string }).token;
    const signerId = created.signers[0].id;

    const { url } = await updateSigner(ctx, signerId, { name: "Jordan Avery", email: "Jordan@Example.com" });
    await flushDeferred();
    const newToken = tokenOf(url);
    expect(newToken).not.toBe(oldToken);

    // The link that went to the wrong address is dead.
    expect(await getSigningView(oldToken)).toBeNull();
    await expect(submitSigning(oldToken, { consent: true, values: {} }, meta)).rejects.toThrow(/not valid/i);

    const view = (await getSigningView(newToken))!;
    expect(view.signer).toMatchObject({ name: "Jordan Avery", email: "jordan@example.com", consented: false });
    // The name printed on the agreement and the file itself follow the correction.
    expect(view.fields.find((f) => f.id === "printed_client")?.value).toBe("Jordan Avery");
    const detail = (await getFile(ctx, created.file.id))!;
    expect(detail.file).toMatchObject({ clientName: "Jordan Avery", clientEmail: "jordan@example.com" });

    const db = await getDb();
    const trail = await envelopeEvents(db, detail.envelopes[0].id);
    const event = trail.find((e) => e.type === "agreement.signer_updated")!;
    expect(event.data).toMatchObject({ from: { name: "Jordon Avery", email: "jordon@exmaple.com" }, to: { name: "Jordan Avery", email: "jordan@example.com" } });
    expect(verifyChain(trail).ok).toBe(true);
    const sent = await db.select().from(emails).where(eq(emails.fileId, created.file.id));
    expect(sent.map((e) => e.toEmail)).toEqual(expect.arrayContaining(["jordon@exmaple.com", "jordan@example.com"]));
    expect(sent.find((e) => e.toEmail === "jordan@example.com")!.html).toContain(`/sign/${newToken}`);

    // The corrected link signs normally.
    const done = await submitSigning(newToken, { consent: true, values: fill(detail.envelopes[0].fields, "client", "Jordan Avery") }, meta);
    await flushDeferred();
    expect(done.status).toBe("completed");
    await expect(updateSigner(ctx, signerId, { name: "Someone Else", email: "x@example.com" })).rejects.toThrow(/no longer out for signature/i);
  });

  it("rejects no-op edits, bad input and other tenants", async () => {
    const created = await createFile(ctx, { signers: [{ role: "client", name: "Pat Lee", email: "pat@example.com" }] });
    const id = created.signers[0].id;
    await expect(updateSigner(ctx, id, { name: "Pat Lee", email: "pat@example.com" })).rejects.toThrow(/nothing was changed/i);
    await expect(updateSigner(ctx, id, { name: "Pat Lee", email: "not-an-email" })).rejects.toThrow();
    const other = await workspace("Rival Firm", "owner@rival.test");
    await expect(updateSigner(other.ctx, id, { name: "Hacked", email: "h@example.com" })).rejects.toThrow(/not found/i);
    await flushDeferred();
  });

  it("locks names once anyone has signed, but still lets an email be fixed", async () => {
    const pdf = await buildSampleAgreement("Acme Adjusters");
    const { id } = await ingestDocument(ctx, { bytes: pdf.bytes, filename: "joint.pdf" });
    const second = pdf.fields.filter((f) => f.assignee === "client").map((f) => ({ ...f, id: `${f.id}_b`, assignee: "client2", y: f.y + 0.4 }));
    await saveTemplate(ctx, id, { roles: [{ key: "client", label: "Client" }, { key: "client2", label: "Co-owner" }], fields: [...pdf.fields, ...second] }, { publish: true });
    const created = await createFile(ctx, {
      templateId: id,
      signers: [
        { role: "client", name: "Ana Diaz", email: "ana@example.com" },
        { role: "client2", name: "Luis Diaz", email: "luis@exmaple.com" },
      ],
    });
    const [ana, luis] = created.signers as { id: string; token: string }[];
    await submitSigning(ana.token, { consent: true, values: fill(created.envelope!.fields, "client", "Ana Diaz") }, meta);

    await expect(updateSigner(ctx, luis.id, { name: "Luiz Diaz", email: "luis@exmaple.com" })).rejects.toThrow(/names can no longer change/i);
    await expect(updateSigner(ctx, ana.id, { name: "Ana Diaz", email: "new@example.com" })).rejects.toThrow(/already responded/i);
    const fixed = await updateSigner(ctx, luis.id, { name: "Luis Diaz", email: "luis@example.com" });
    const done = await submitSigning(tokenOf(fixed.url), { consent: true, values: fill(created.envelope!.fields, "client2", "Luis Diaz") }, meta);
    await flushDeferred();
    expect(done.status).toBe("completed");
  });
});

describe("client preview", () => {
  it("shows what a client would see without writing anything", async () => {
    const db = await getDb();
    const counts = async () => [(await db.select({ n: count() }).from(files))[0].n, (await db.select({ n: count() }).from(envelopes))[0].n, (await db.select({ n: count() }).from(emails))[0].n];
    const before = await counts();

    const view = (await getPreviewView(ctx, templateId))!;
    expect(view.state).toBe("sign");
    expect(view.agreement.docId).toBe("PREVIEW");
    expect(view.fields.filter((f) => f.mine).every((f) => f.assignee === "client")).toBe(true);
    expect(view.fields.filter((f) => f.mine).some((f) => f.type === "signature")).toBe(true);
    // Automatic fields are filled the same way a real send fills them.
    expect(view.fields.find((f) => f.id === "printed_client")?.value).toBe("Sample Client");
    expect(view.fields.find((f) => f.assignee === "auto" && f.type === "signature")?.value).toBeTruthy();

    expect(await counts()).toEqual(before);
    const other = await workspace("Preview Rival", "owner@preview-rival.test");
    expect(await getPreviewView(other.ctx, templateId)).toBeNull();
  });
});

describe("team access", () => {
  it("lets the owner remove a teammate and end their sessions, and nobody else", async () => {
    const invite = await createInvite(ctx);
    const member = await acceptInvite(tokenOf(invite), { name: "Sam Member", email: "sam@acme.test", password: "another long password" });
    expect(await sessionFromToken(member.token)).not.toBeNull();
    const sam = (await listMembers(ctx)).find((m) => m.email === "sam@acme.test")!;
    const samCtx: Ctx = { ...ctx, userId: sam.id };

    await expect(removeMember(samCtx, "member", ctx.userId!)).rejects.toThrow(/only the workspace owner/i);
    await expect(removeMember(ctx, "owner", ctx.userId!)).rejects.toThrow(/cannot remove yourself/i);
    const other = await workspace("Team Rival", "owner@team-rival.test");
    await expect(removeMember(other.ctx, "owner", sam.id)).rejects.toThrow(/not found/i);

    await removeMember(ctx, "owner", sam.id);
    expect(await sessionFromToken(member.token)).toBeNull();
    expect((await listMembers(ctx)).some((m) => m.id === sam.id)).toBe(false);
    await expect(login({ email: "sam@acme.test", password: "another long password" })).rejects.toThrow(/do not match/i);
  });
});

describe("password reset", () => {
  it("mints nothing when no mail provider is configured", async () => {
    const db = await getDb();
    const r = await requestPasswordReset("owner@acme.test", BASE);
    expect(r.delivery).toBe(false);
    expect((await db.select({ n: count() }).from(passwordResets))[0].n).toBe(0);
  });

  it("lets an owner issue a one-time link that changes the password and signs out other sessions", async () => {
    const invite = await createInvite(ctx);
    const member = await acceptInvite(tokenOf(invite), { name: "Kim Member", email: "kim@acme.test", password: "original password 1" });
    const kim = (await listMembers(ctx)).find((m) => m.email === "kim@acme.test")!;

    await expect(createResetLink({ ...ctx, userId: kim.id }, "member", ctx.userId!)).rejects.toThrow(/only the workspace owner/i);
    const other = await workspace("Reset Rival", "owner@reset-rival.test");
    await expect(createResetLink(other.ctx, "owner", kim.id)).rejects.toThrow(/not found/i);

    const token = tokenOf(await createResetLink(ctx, "owner", kim.id));
    expect((await findReset(token))?.name).toBe("Kim Member");
    await expect(resetPassword(token, { password: "short" })).rejects.toThrow();
    const fresh = await resetPassword(token, { password: "brand new password 2" });

    expect(await sessionFromToken(member.token)).toBeNull();
    expect(await sessionFromToken(fresh.token)).not.toBeNull();
    await expect(login({ email: "kim@acme.test", password: "original password 1" })).rejects.toThrow(/do not match/i);
    expect((await login({ email: "kim@acme.test", password: "brand new password 2" })).userId).toBe(kim.id);
    // Single use, and garbage tokens are not looked up at all.
    expect(await findReset(token)).toBeNull();
    await expect(resetPassword(token, { password: "yet another password 3" })).rejects.toThrow(/expired or was already used/i);
    expect(await findReset("../../etc/passwd")).toBeNull();
    expect(await sessionFromToken(ownerSession)).not.toBeNull();
  });

  it("expires links after an hour", async () => {
    const kim = (await listMembers(ctx)).find((m) => m.email === "kim@acme.test")!;
    const token = tokenOf(await createResetLink(ctx, "owner", kim.id));
    const db = await getDb();
    await db.update(passwordResets).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(passwordResets.userId, kim.id));
    expect(await findReset(token)).toBeNull();
  });

  it("emails the link when a provider is configured, without revealing accounts or storing the link", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    const sentBodies: { to: string[]; html: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
      }),
    );
    const db = await getDb();
    const before = (await db.select({ n: count() }).from(passwordResets))[0].n;

    // Unknown address: same answer, nothing sent, nothing minted.
    expect(await requestPasswordReset("nobody@nowhere.test", BASE)).toEqual({ delivery: true });
    expect(sentBodies).toHaveLength(0);
    expect((await db.select({ n: count() }).from(passwordResets))[0].n).toBe(before);

    expect(await requestPasswordReset("OWNER@acme.test", BASE)).toEqual({ delivery: true });
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0].to).toEqual(["owner@acme.test"]);
    const link = sentBodies[0].html.match(/http:\/\/localhost:3000\/reset\/([A-Za-z0-9_-]+)/)!;
    expect(await findReset(link[1])).not.toBeNull();

    // Teammates can read the Outbox, so its copy must not contain the link.
    const [stored] = await db.select().from(emails).where(eq(emails.kind, "password_reset"));
    expect(stored.status).toBe("delivered");
    expect(stored.html).not.toContain(link[1]);
    expect(stored.html).not.toContain("/reset/");
  });
});
