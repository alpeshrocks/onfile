import { describe, expect, it } from "vitest";
import { detectFields, type PageText, type TextItem } from "@/lib/detect";
import { AUTO } from "@/lib/types";
import { extract, formAgreement, rotatedAgreement, ruledAgreement } from "./helpers/pdf";

/** Build positioned text the way pdf.js reports it: one item per run, on a US Letter page. */
function page(lines: [number, number, string][], size = 11): PageText {
  const items: TextItem[] = lines.map(([x, y, str]) => ({
    str,
    x: x / 612,
    y: y / 792,
    w: (str.length * size * 0.5) / 612,
    h: size / 792,
  }));
  return { page: 0, width: 612, height: 792, items };
}

describe("field detection on positioned text", () => {
  it("finds labelled blanks and assigns each party's fields", () => {
    const d = detectFields(
      [
        page([
          [72, 100, "CLIENT"],
          [72, 130, "Signature: ______________________________     Date: ________________"],
          [72, 160, "Printed name: ___________________________"],
          [72, 220, "ASTRA AI"],
          [72, 250, "By: ____________________________________     Date: ________________"],
          [72, 280, "Name: __________________________________     Title: _______________"],
        ]),
      ],
      [],
      { firmName: "Astra AI" },
    );
    const client = d.fields.filter((f) => f.assignee === "client");
    const firm = d.fields.filter((f) => f.assignee === AUTO);
    expect(client.map((f) => f.type).sort()).toEqual(["date", "name", "signature"]);
    expect(firm.map((f) => f.type).sort()).toEqual(["date", "signature", "text", "text"]);
    expect(firm.filter((f) => f.type === "text").map((f) => f.variable).sort()).toEqual(["firm_signer_name", "firm_signer_title"]);
    // The firm's right-hand column inherits the role of its block, not the client's.
    const firmDate = firm.find((f) => f.type === "date")!;
    expect(firmDate.x).toBeGreaterThan(0.4);
  });

  it("reads a label printed under the blank", () => {
    const d = detectFields([
      page([
        [72, 400, "______________________________        ________________"],
        [72, 416, "Client Signature                                 Date"],
      ]),
    ]);
    expect(d.fields.map((f) => f.type)).toEqual(["signature", "date"]);
    expect(d.fields.every((f) => f.assignee === "client")).toBe(true);
  });

  it("turns placeholders into automatic fields that cover the placeholder text", () => {
    const d = detectFields([page([[72, 120, "This agreement is made with [Client Name] regarding file {{file_number}} at [Property Address]."]])]);
    const byVar = Object.fromEntries(d.fields.map((f) => [f.variable, f]));
    expect(byVar.client_name?.assignee).toBe(AUTO);
    expect(byVar.client_name?.mask).toBe(true);
    expect(byVar.file_reference?.assignee).toBe(AUTO);
    // An unknown placeholder becomes a custom value the firm fills in per file.
    expect(d.variables.map((v) => v.label)).toEqual(["Property Address"]);
    expect(byVar.property_address?.assignee).toBe(AUTO);
  });

  it("treats an inline blank next to a party definition as that party's name", () => {
    const d = detectFields([page([[72, 120, 'This Agreement is between ____________________ (the "Client") and the Firm.']])]);
    expect(d.fields).toHaveLength(1);
    expect(d.fields[0]).toMatchObject({ assignee: AUTO, variable: "client_name" });
  });

  it("detects a co-signer block as a second signer", () => {
    const d = detectFields([
      page([
        [72, 100, "Client Signature: ______________________________"],
        [72, 160, "Co-Client Signature: ___________________________"],
      ]),
    ]);
    expect(d.fields.map((f) => f.assignee)).toEqual(["client", "client2"]);
    expect(d.roles.map((r) => r.key)).toEqual(["client", "client2"]);
  });

  it("ignores bracketed boilerplate and ordinary sentences", () => {
    const d = detectFields([page([[72, 120, "[Signature Page Follows]"], [72, 150, "The client shall sign and date this agreement before work begins."]])]);
    expect(d.fields).toHaveLength(0);
  });

  it("reports when a document has no text layer at all", () => {
    expect(detectFields([{ page: 0, width: 612, height: 792, items: [] }]).hasText).toBe(false);
  });
});

describe("field detection on real PDFs (through pdf.js)", () => {
  it("handles signature lines drawn as rules with labels underneath, in two columns", async () => {
    const { pages, widgets } = await extract(await ruledAgreement());
    const d = detectFields(pages, widgets, { firmName: "MIND" });
    const client = d.fields.filter((f) => f.assignee === "client");
    const firm = d.fields.filter((f) => f.assignee === AUTO);
    expect(client.map((f) => f.type).sort()).toEqual(["date", "name", "signature"]);
    expect(firm.some((f) => f.type === "signature")).toBe(true);
    // The client signature box sits on the rule at y=500pt (792-500 from the top), left column.
    const sig = client.find((f) => f.type === "signature")!;
    expect(sig.x).toBeCloseTo(72 / 612, 1);
    expect(sig.y + sig.h).toBeGreaterThan((792 - 505) / 792);
    expect(sig.y + sig.h).toBeLessThan((792 - 485) / 792);
    expect(firm.find((f) => f.type === "signature")!.x).toBeGreaterThan(0.5);
  });

  it.each([0, 90, 180, 270] as const)("finds the signature line on a page rotated %i degrees", async (rotation) => {
    const { pages } = await extract(await rotatedAgreement(rotation));
    const d = detectFields(pages);
    expect(d.fields.map((f) => f.type)).toEqual(["signature", "name"]);
  });

  it("prefers real form fields and still finds the signature line in the text", async () => {
    const { pages, widgets } = await extract(await formAgreement());
    expect(widgets).toHaveLength(3);
    const d = detectFields(pages, widgets);
    expect(d.fields.filter((f) => f.source === "form").map((f) => f.type).sort()).toEqual(["checkbox", "date", "name"]);
    expect(d.fields.filter((f) => f.type === "signature")).toHaveLength(1);
  });
});
