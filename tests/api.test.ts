import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getAgreement } from "@/app/api/v1/files/[id]/agreement/route";
import { GET as getOne } from "@/app/api/v1/files/[id]/route";
import { GET as list, POST as create } from "@/app/api/v1/files/route";
import { POST as signPost } from "@/app/api/sign/[token]/[action]/route";
import { syntheticSignature } from "@/lib/signature";
import type { FieldValue } from "@/lib/types";
import { flushDeferred, type Ctx } from "@/server/context";
import { hmacHex } from "@/server/crypto";
import { resetDb } from "@/server/db";
import { createApiKey, createWebhook, revokeApiKey, setFirmSigner, signup } from "@/server/services/accounts";
import { buildSampleAgreement } from "@/server/services/demo";
import { getFile } from "@/server/services/files";
import { ingestDocument, saveTemplate } from "@/server/services/templates";

/**
 * The integration surface a customer's own system uses: REST with an API key, and signed
 * webhooks. Route handlers are called directly with real Request objects.
 */

const BASE = "http://localhost:3000";
let ctx: Ctx;
let key: { id: string; secret: string };
let otherKey: string;
let hook: { secret: string };
let server: Server;
const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];

const req = (path: string, init: RequestInit & { key?: string } = {}) =>
  new Request(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.key === "" ? {} : { Authorization: `Bearer ${init.key ?? key.secret}` }), ...init.headers },
  });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function workspace(company: string, email: string): Promise<Ctx> {
  const a = await signup({ name: "Owner", company, email, password: "correct horse battery" });
  return { workspaceId: a.workspaceId, userId: a.userId, actor: { kind: "user", name: "Owner", email }, baseUrl: BASE };
}

beforeAll(async () => {
  await resetDb();
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (c) => (body += c));
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      response.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  ctx = await workspace("Acme Adjusters", "api-owner@acme.test");
  const pdf = await buildSampleAgreement("Acme Adjusters");
  const { id } = await ingestDocument(ctx, { bytes: pdf.bytes, filename: "agreement.pdf" });
  await setFirmSigner(ctx, { name: "Riley Stone", title: "Principal", signature: syntheticSignature("Riley Stone") });
  await saveTemplate(ctx, id, { fields: pdf.fields }, { publish: true });
  key = await createApiKey(ctx, "Case system");
  hook = await createWebhook(ctx, `http://127.0.0.1:${(server.address() as AddressInfo).port}/onfile`);
  otherKey = (await createApiKey(await workspace("Rival", "api-owner@rival.test"), "Rival")).secret;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("REST API", () => {
  it("rejects missing, malformed and revoked keys", async () => {
    expect((await list(req("/api/v1/files", { key: "" }))).status).toBe(401);
    expect((await list(req("/api/v1/files", { key: "onf_live_not-a-real-key" }))).status).toBe(401);
    const temp = await createApiKey(ctx, "Temporary");
    expect((await list(req("/api/v1/files", { key: temp.secret }))).status).toBe(200);
    await revokeApiKey(ctx, temp.id);
    expect((await list(req("/api/v1/files", { key: temp.secret }))).status).toBe(401);
  });

  it("validates the request body and names the field at fault", async () => {
    const res = await create(req("/api/v1/files", { method: "POST", body: JSON.stringify({ client: { name: "No Email" } }) }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.field).toBe("client.email");
    const bad = await create(req("/api/v1/files", { method: "POST", body: JSON.stringify({ client: { name: "Pat", email: "not-an-email" } }) }));
    expect(bad.status).toBe(422);
  });

  it("opens a file, is safe to retry, reports status, and serves the signed PDF", async () => {
    const body = JSON.stringify({ external_id: "case-20418", title: "Kitchen water damage", client: { name: "Jordan Avery", email: "jordan.avery@example.com" } });
    const first = await create(req("/api/v1/files", { method: "POST", body }));
    expect(first.status).toBe(201);
    const created = await first.json();
    expect(created.file).toMatchObject({ status: "awaiting_signature", cleared_to_start: false, external_id: "case-20418" });
    const signingUrl: string = created.agreement.signers[0].signing_url;
    expect(signingUrl).toMatch(/^http:\/\/localhost:3000\/sign\/[A-Za-z0-9_-]{43}$/);

    const retry = await create(req("/api/v1/files", { method: "POST", body }));
    expect(retry.status).toBe(200);
    expect((await retry.json()).file.id).toBe(created.file.id);

    // Tenant isolation at the API: another workspace's key cannot see the file.
    expect((await getOne(req("/api/v1/files/case-20418", { key: otherKey }), idParams("case-20418"))).status).toBe(404);
    expect((await getAgreement(req("/api/v1/files/case-20418/agreement"), idParams("case-20418"))).status).toBe(409);

    // The client signs through the public signing endpoints, exactly as a browser would.
    const token = signingUrl.split("/sign/")[1];
    const detail = (await getFile(ctx, created.file.id))!;
    const values: Record<string, FieldValue> = {};
    for (const f of detail.envelopes[0].fields) {
      if (f.assignee !== "client") continue;
      if (f.type === "signature") values[f.id] = syntheticSignature("Jordan Avery");
      if (f.type === "name") values[f.id] = "Jordan Avery";
    }
    const sign = (action: string, payload: unknown = {}) =>
      signPost(new Request(`${BASE}/api/sign/${token}/${action}`, { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.9" }, body: JSON.stringify(payload) }), {
        params: Promise.resolve({ token, action }),
      });
    expect((await sign("view")).status).toBe(200);
    expect((await sign("consent")).status).toBe(200);
    expect((await sign("submit", { consent: false, values })).status).toBe(422);
    const done = await sign("submit", { consent: true, values });
    expect(await done.json()).toEqual({ status: "completed" });
    expect((await sign("submit", { consent: true, values })).status).toBe(409);
    expect((await sign("nonsense")).status).toBe(404);
    await flushDeferred();

    const status = await (await getOne(req("/api/v1/files/case-20418"), idParams("case-20418"))).json();
    expect(status.file).toMatchObject({ status: "signed", cleared_to_start: true });
    expect(status.agreement.signers[0]).toMatchObject({ status: "signed", signing_url: null });
    expect(status.agreement.signed_sha256).toMatch(/^[a-f0-9]{64}$/);

    const pdf = await getAgreement(req("/api/v1/files/case-20418/agreement"), idParams("case-20418"));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    expect(bytes.byteLength).toBe(Number(pdf.headers.get("content-length")));

    // Byte ranges, as pdf.js and download managers request them.
    const part = await getAgreement(req("/api/v1/files/case-20418/agreement", { headers: { Range: "bytes=0-99" } }), idParams("case-20418"));
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-99/${bytes.byteLength}`);
    expect((await part.arrayBuffer()).byteLength).toBe(100);

    const listed = await (await list(req("/api/v1/files?status=signed"))).json();
    expect(listed.data.map((f: { external_id: string }) => f.external_id)).toContain("case-20418");
  });

  it("delivers signed webhooks for each step", async () => {
    const types = received.map((r) => JSON.parse(r.body).type);
    expect(types).toEqual(expect.arrayContaining(["agreement.sent", "agreement.viewed", "agreement.signed", "agreement.completed"]));
    for (const r of received) {
      const header = String(r.headers["x-onfile-signature"]);
      const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
      expect(v1).toBe(hmacHex(hook.secret, `${t}.${r.body}`));
      expect(Math.abs(Date.now() / 1000 - Number(t))).toBeLessThan(60);
    }
    const completed = JSON.parse(received.find((r) => JSON.parse(r.body).type === "agreement.completed")!.body);
    expect(completed.data.file).toMatchObject({ external_id: "case-20418", cleared_to_start: true });
  });
});
