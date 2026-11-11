import { describe, expect, it } from "vitest";
import { csvToRecords, parseCsv } from "@/lib/csv";
import { formatDuration, longDate, maskEmail, slugKey, timeAgo } from "@/lib/format";
import { inkLength, normalizeStrokes, strokesToPath, syntheticSignature } from "@/lib/signature";
import { AUTO, signatureValueSchema, type Field } from "@/lib/types";
import { requiredInputs, templateIssues } from "@/lib/validate";
import { canonicalJson, decrypt, encrypt, hashPassword, hmacHex, newDocId, newId, randomToken, safeEqual, sha256Hex, verifyPassword } from "@/server/crypto";
import { renderEmail } from "@/server/email";
import { isSafeWebhookUrl } from "@/server/webhooks";

const field = (over: Partial<Field>): Field => ({ id: "f1", type: "signature", page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.05, assignee: "client", required: true, ...over });

describe("csv", () => {
  it("parses quoted cells, escaped quotes, CRLF and a BOM", () => {
    expect(parseCsv('﻿name,note\r\n"Avery, Jordan","said ""hi"""\r\n\r\nLee,ok')).toEqual([
      ["name", "note"],
      ["Avery, Jordan", 'said "hi"'],
      ["Lee", "ok"],
    ]);
  });
  it("normalizes headers so spreadsheet exports match", () => {
    const { headers, records } = csvToRecords("Client Name,Client E-mail,File #\nPat Lee,pat@example.com,A-1");
    expect(headers).toEqual(["client_name", "client_e_mail", "file"]);
    expect(records[0].client_name).toBe("Pat Lee");
  });
});

describe("crypto", () => {
  it("round-trips encryption and rejects tampering", () => {
    const sealed = encrypt("signing-token");
    expect(sealed).not.toContain("signing-token");
    expect(decrypt(sealed)).toBe("signing-token");
    const [iv, tag, data] = sealed.split(".");
    expect(() => decrypt([iv, tag, data.slice(0, -2) + "AA"].join("."))).toThrow();
  });
  it("hashes passwords with a per-password salt", async () => {
    const a = await hashPassword("correct horse");
    const b = await hashPassword("correct horse");
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse", a)).toBe(true);
    expect(await verifyPassword("wrong horse", a)).toBe(false);
    expect(await verifyPassword("anything", "garbage")).toBe(false);
  });
  it("produces stable canonical JSON regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }));
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("generates well-formed ids and tokens", () => {
    expect(newId("file")).toMatch(/^file_[0-9A-Za-z]{18}$/);
    expect(newDocId()).toMatch(/^ONF-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(Array.from({ length: 200 }, () => randomToken())).size).toBe(200);
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "b")).toBe(false);
    expect(hmacHex("k", "v")).toHaveLength(64);
  });
});

describe("signatures", () => {
  it("normalizes strokes to their bounding box and builds a path", () => {
    const n = normalizeStrokes([[100, 200, 150, 240, 180, 210]], 4);
    expect(n.strokes[0].slice(0, 2)).toEqual([4, 4]);
    expect(n.width).toBe(88);
    expect(n.height).toBe(48);
    expect(strokesToPath(n.strokes)).toMatch(/^M4 4Q/);
    expect(inkLength(n.strokes)).toBeGreaterThan(90);
  });
  it("accepts real signatures and rejects malformed payloads", () => {
    expect(signatureValueSchema.safeParse(syntheticSignature("Pat Lee")).success).toBe(true);
    expect(signatureValueSchema.safeParse({ kind: "drawn", strokes: [], width: 10, height: 10 }).success).toBe(false);
    expect(signatureValueSchema.safeParse({ kind: "typed", text: "x", dataUrl: "data:text/html;base64,AAAA", width: 1, height: 1 }).success).toBe(false);
    expect(signatureValueSchema.safeParse({ kind: "typed", text: "x", dataUrl: "javascript:alert(1)", width: 1, height: 1 }).success).toBe(false);
  });
});

describe("template validation", () => {
  const base = { roles: [{ key: "client", label: "Client" }], variables: [], pageCount: 1 };
  it("requires a signature field for every signer", () => {
    const issues = templateIssues({ ...base, fields: [field({ type: "date" })] }, true);
    expect(issues.some((i) => i.level === "error" && i.fix === "add_signature_page")).toBe(true);
    expect(templateIssues({ ...base, fields: [field({})] }, true).filter((i) => i.level === "error")).toHaveLength(0);
  });
  it("requires a firm signature before the firm can sign automatically", () => {
    const fields = [field({}), field({ id: "f2", assignee: AUTO })];
    expect(templateIssues({ ...base, fields }, false).some((i) => i.fix === "firm_signature")).toBe(true);
    expect(templateIssues({ ...base, fields }, true).filter((i) => i.level === "error")).toHaveLength(0);
  });
  it("flags automatic text with no source, and lists custom values to ask for", () => {
    const fields = [field({}), field({ id: "f2", type: "text", assignee: AUTO }), field({ id: "f3", type: "text", assignee: AUTO, variable: "fee" })];
    const variables = [{ key: "fee", label: "Fee", required: true }, { key: "unused", label: "Unused", required: true }];
    expect(templateIssues({ ...base, fields, variables }, true).some((i) => i.fieldId === "f2")).toBe(true);
    expect(requiredInputs({ fields, variables }).map((v) => v.key)).toEqual(["fee"]);
  });
});

describe("formatting and safety helpers", () => {
  it("formats durations, dates and relative times", () => {
    expect(formatDuration(30_000)).toBe("under a minute");
    expect(formatDuration(45 * 60_000)).toBe("45 min");
    expect(formatDuration(3 * 3_600_000)).toBe("3 hr");
    expect(formatDuration(4 * 86_400_000)).toBe("4 days");
    expect(longDate(new Date("2026-03-01T03:00:00Z"), "America/Los_Angeles")).toBe("February 28, 2026");
    expect(longDate(new Date("2026-03-01T03:00:00Z"), "Not/AZone")).toBe("March 1, 2026");
    expect(timeAgo(new Date(Date.now() - 2 * 86_400_000))).toBe("2 days ago");
    expect(slugKey("Fee percentage (%)")).toBe("fee_percentage");
    expect(maskEmail("jordan@example.com")).toBe("j*****@example.com");
  });
  it("escapes everything interpolated into emails", () => {
    const html = renderEmail({ firmName: "<script>x</script>", brandColor: "red;background:url(x)", heading: "Hi", paragraphs: ['"quoted" & <b>bold</b>'], cta: { label: "Go", url: 'https://x.test/?a="b"' } });
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain("<b>bold");
    expect(html).not.toContain("url(x)");
    expect(html).toContain("&lt;script&gt;");
  });
  it("accepts only http(s) webhook targets", () => {
    expect(isSafeWebhookUrl("https://hooks.example.com/onfile")).toBe(true);
    expect(isSafeWebhookUrl("ftp://example.com")).toBe(false);
    expect(isSafeWebhookUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeWebhookUrl("not a url")).toBe(false);
  });
});
