import { eq } from "drizzle-orm";
import { syntheticSignature } from "@/lib/signature";
import { putBlob } from "../blobs";
import { withClock } from "../clock";
import { flushDeferred, type Ctx } from "../context";
import { newId, randomToken } from "../crypto";
import { getDb } from "../db";
import { templates, workspaces } from "../db/schema";
import { inspectPdf } from "../pdf/finalize";
import { appendSignaturePage, textToBlocks, typesetBlocks } from "../pdf/typeset";
import { setFirmSigner, signup } from "./accounts";
import { createFile } from "./files";
import { declineSigning, recordConsent, recordView, submitSigning } from "./signing";
import { DEFAULT_ROLES, type FieldValue } from "@/lib/types";

export const SAMPLE_AGREEMENT = `# Client Services Agreement

This Client Services Agreement (the "Agreement") is entered into between the Client named on the signature page and the Firm. It sets out the terms on which the Firm will act for the Client on the file identified below.

## 1. Scope of services

The Firm will provide the professional services reasonably required to open, manage and complete the Client's file. The Firm will keep the Client informed of material developments and will respond to the Client's questions within two business days.

## 2. Client responsibilities

The Client agrees to:
- provide complete and accurate information and documents when requested;
- respond promptly to questions that affect the progress of the file;
- tell the Firm about any change in contact details or circumstances.

## 3. Fees

Fees are charged as set out in the fee schedule provided to the Client before signing. No work begins, and no fees accrue, until this Agreement has been signed by both parties.

## 4. Confidentiality

Each party will keep confidential all non-public information received from the other in connection with the file, and will use it only for the purposes of this Agreement, unless disclosure is required by law.

## 5. Term and cancellation

This Agreement begins on the date it is signed by both parties and continues until the file is closed. The Client may cancel in writing at any time. Fees for work properly performed before cancellation remain payable.

## 6. Electronic signatures

The parties agree that this Agreement may be signed electronically, and that electronic signatures and records have the same effect as handwritten signatures and paper records.

## 7. Entire agreement

This Agreement is the entire agreement between the parties about its subject matter and replaces any earlier discussions. Changes must be agreed in writing by both parties.
`;

/** The same agreement written the way firms usually have it: blanks for signatures. */
export function sampleAgreementWithBlanks(firmName: string) {
  return `${SAMPLE_AGREEMENT}
## Signatures

CLIENT

Signature: ______________________________     Date: ________________

Printed name: ___________________________

${firmName.toUpperCase()}

By: ____________________________________     Date: ________________

Name: __________________________________     Title: _______________
`;
}

/** Build the sample agreement: typeset text plus an Onfile signature page with fields in place. */
export async function buildSampleAgreement(firmName: string) {
  const body = await typesetBlocks(textToBlocks(SAMPLE_AGREEMENT), { title: "Client Services Agreement" });
  const signed = await appendSignaturePage(body, { roles: DEFAULT_ROLES, firmName, includeFirm: true });
  const { pages } = await inspectPdf(signed.bytes);
  return { bytes: signed.bytes, pages, fields: signed.fields };
}

const PEOPLE: [string, string, string][] = [
  ["Jordan Avery", "jordan.avery@example.com", "Kitchen water damage"],
  ["Priya Raman", "priya.raman@example.com", "Roof storm claim"],
  ["Marcus Bell", "marcus.bell@example.com", "Commercial lease review"],
  ["Elena Sokolova", "elena.sokolova@example.com", "Estate filing"],
  ["Tomás Herrera", "tomas.herrera@example.com", "Basement flood"],
  ["Grace Okafor", "grace.okafor@example.com", "Vehicle total loss"],
  ["Daniel Kim", "daniel.kim@example.com", "Property tax appeal"],
];

/**
 * A private sandbox per visitor: a new workspace with a published agreement and files in
 * every state. Built by driving the real services (send, open, sign, decline), so the
 * demo data is produced by exactly the code a customer runs. All names are fictional.
 */
export async function createDemoWorkspace(baseUrl: string, timeZone?: string) {
  const db = await getDb();
  const account = await signup(
    { name: "Demo User", company: "Harbor & Vale Associates", email: `demo-${randomToken(6).toLowerCase()}@demo.onfile.test`, password: randomToken(18), timeZone },
    { demo: true },
  );
  const ctx: Ctx = { workspaceId: account.workspaceId, userId: account.userId, actor: { kind: "user", name: "Demo User" }, baseUrl };
  await setFirmSigner(ctx, { name: "Dana Whitfield", title: "Managing Partner", signature: syntheticSignature("Dana Whitfield") });

  const sample = await buildSampleAgreement("Harbor & Vale Associates");
  const blob = await putBlob(db, ctx.workspaceId, sample.bytes, "application/pdf");
  const templateId = newId("tpl");
  await db.insert(templates).values({
    id: templateId,
    workspaceId: ctx.workspaceId,
    name: "Client Services Agreement",
    status: "active",
    isDefault: true,
    blobId: blob.id,
    sha256: blob.sha256,
    pages: sample.pages,
    fields: sample.fields,
    roles: DEFAULT_ROLES,
    detected: true,
    version: 1,
    publishedAt: new Date(),
    createdBy: account.userId,
  });

  // [days ago sent, outcome, hours until the outcome]
  const plan: [number, "signed" | "viewed" | "sent" | "declined", number][] = [
    [9, "signed", 3],
    [7, "signed", 26],
    [6, "declined", 20],
    [4, "signed", 0.4],
    [3, "viewed", 5],
    [1, "sent", 0],
    [0, "sent", 0],
  ];

  for (let i = 0; i < plan.length; i++) {
    const [daysAgo, outcome, hours] = plan[i];
    const [name, email, title] = PEOPLE[i];
    const meta = { ip: `203.0.113.${20 + i}`, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1", baseUrl };
    // Each step runs "at" its own moment through the injectable clock, so seeded history
    // has real timestamps and an intact audit chain, exactly like live data.
    const sentAt = new Date(Date.now() - daysAgo * 86_400_000 - ((i % 3) + 1) * 2_700_000);
    const outcomeAt = new Date(Math.min(Date.now() - 120_000, sentAt.getTime() + hours * 3_600_000));

    const created = await withClock(sentAt, async () => {
      const r = await createFile(ctx, { title, signers: [{ role: "client", name, email }], source: "demo" });
      await flushDeferred();
      return r;
    });
    const token = (created.signers[0] as { token?: string } | undefined)?.token;
    if (!token || !created.envelope || outcome === "sent") continue;

    await withClock(new Date(outcomeAt.getTime() - 90_000), () => recordView(token, meta));
    await withClock(outcomeAt, async () => {
      if (outcome === "signed") {
        await recordConsent(token, meta);
        const values: Record<string, FieldValue> = {};
        for (const f of created.envelope!.fields) {
          if (f.assignee !== "client") continue;
          if (f.type === "signature") values[f.id] = syntheticSignature(name);
          else if (f.type === "name") values[f.id] = name;
        }
        await submitSigning(token, { consent: true, values, timeZone }, meta);
      }
      if (outcome === "declined") await declineSigning(token, "I would like to discuss the fee schedule before signing.", meta);
      await flushDeferred();
    });
  }
  await db.update(workspaces).set({ isDemo: true }).where(eq(workspaces.id, ctx.workspaceId));
  return account;
}
