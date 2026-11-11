import { describe, expect, it } from "vitest";
import { detectFields } from "@/lib/detect";
import { clampRect, displayedSize, normalizeRotation, overlapRatio, toUserSpace } from "@/lib/geometry";
import { syntheticSignature } from "@/lib/signature";
import type { EnvelopeField } from "@/lib/types";
import { finalizePdf } from "@/server/pdf/finalize";
import { extract, rotatedAgreement } from "./helpers/pdf";

const certificate = {
  workspaceName: "Acme",
  fileReference: "F-0001",
  fileTitle: "",
  templateName: "Agreement",
  templateVersion: 1,
  docId: "ONF-TEST-TEST-TEST",
  sourceSha256: "0".repeat(64),
  sentAt: new Date("2026-01-01T00:00:00Z"),
  completedAt: new Date("2026-01-01T01:00:00Z"),
  pageCount: 1,
  signers: [],
  firmSigner: null,
  events: [],
  auditHead: "",
  verifyUrl: "http://localhost/verify",
};

describe("page geometry", () => {
  it("maps displayed corners into the crop box for every rotation", () => {
    for (const rotation of [0, 90, 180, 270]) {
      const box = { x: 10, y: 20, width: 600, height: 800, rotation };
      const size = displayedSize(box);
      for (const [vx, vy] of [
        [0, 0],
        [size.width, 0],
        [0, size.height],
        [size.width, size.height],
      ]) {
        const p = toUserSpace(box, vx, vy);
        expect(p.x).toBeGreaterThanOrEqual(10);
        expect(p.x).toBeLessThanOrEqual(610);
        expect(p.y).toBeGreaterThanOrEqual(20);
        expect(p.y).toBeLessThanOrEqual(820);
      }
    }
    // Unrotated: displayed top left is the crop box's top left in PDF space.
    expect(toUserSpace({ x: 10, y: 20, width: 600, height: 800, rotation: 0 }, 0, 0)).toEqual({ x: 10, y: 820 });
  });

  it("normalizes odd rotation values and keeps rectangles on the page", () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(clampRect({ x: 0.95, y: -0.2, w: 0.2, h: 0.1 })).toEqual({ x: 0.8, y: 0, w: 0.2, h: 0.1 });
    expect(overlapRatio({ x: 0, y: 0, w: 0.2, h: 0.2 }, { x: 0.1, y: 0, w: 0.2, h: 0.2 })).toBeCloseTo(0.5);
  });

  /**
   * The end to end guarantee: wherever a field is placed on the page as displayed, the
   * stamped value appears there in the final PDF. pdf.js is the judge, and it shares no
   * code with the stamper.
   */
  it.each([
    [0, 0],
    [90, 0],
    [180, 0],
    [270, 0],
    [0, 36],
    [90, 36],
  ] as const)("stamps a value where the field was placed (rotation %i, crop offset %i)", async (rotation, crop) => {
    const source = await rotatedAgreement(rotation, crop);
    const before = await extract(source);
    const detected = detectFields(before.pages).fields;
    const nameField = detected.find((f) => f.type === "name")!;
    const sigField = detected.find((f) => f.type === "signature")!;
    expect(nameField && sigField).toBeTruthy();

    const fields: EnvelopeField[] = detected.map((f) => ({ ...f, assignee: "client" }));
    const signed = await finalizePdf({
      source,
      fields,
      values: { [nameField.id]: "ZZMARKER", [sigField.id]: syntheticSignature("Pat Lee") },
      certificate,
    });

    const after = await extract(signed);
    expect(after.pages.length).toBe(2); // original page plus certificate
    const stamped = after.pages[0].items.find((i) => i.str.includes("ZZMARKER"));
    expect(stamped, "stamped text must be upright and readable on the displayed page").toBeTruthy();
    // Inside the field box, with a small tolerance for font metrics.
    expect(stamped!.x).toBeGreaterThan(nameField.x - 0.01);
    expect(stamped!.x).toBeLessThan(nameField.x + nameField.w);
    expect(stamped!.y).toBeGreaterThan(nameField.y - 0.01);
    expect(stamped!.y + stamped!.h).toBeLessThan(nameField.y + nameField.h + 0.012);
    // The document id is printed at the top left of the displayed page.
    const id = after.pages[0].items.find((i) => i.str.includes("ONF-TEST"));
    expect(id!.x).toBeLessThan(0.1);
    expect(id!.y).toBeLessThan(0.03);
  });
});
