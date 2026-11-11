import { z } from "zod";
import { apiCtx, errorResponse, json } from "@/server/api";
import { createFile, filePayload, getFile, listFiles } from "@/server/services/files";
import type { FileStatus } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const person = z.object({ name: z.string(), email: z.string() });
const body = z.object({
  reference: z.string().optional(),
  external_id: z.string().optional(),
  title: z.string().optional(),
  template_id: z.string().optional(),
  client: person,
  /** Additional signers for agreements with more than one signing party. */
  signers: z.array(person.extend({ role: z.string() })).optional(),
  variables: z.record(z.string()).optional(),
});

/**
 * POST /api/v1/files
 * Open a file. The default agreement is sent to the client immediately.
 * Safe to retry: a repeated external_id returns the existing file instead of sending twice.
 */
export async function POST(request: Request) {
  try {
    const ctx = await apiCtx(request);
    const input = body.parse(await request.json().catch(() => ({})));
    const created = await createFile(ctx, {
      reference: input.reference,
      externalId: input.external_id,
      title: input.title,
      templateId: input.template_id,
      signers: [{ role: "client", ...input.client }, ...(input.signers ?? [])],
      variables: input.variables ?? {},
      source: "api",
    });
    const detail = await getFile(ctx, created.file.id);
    const envelope = detail?.envelopes[0] ?? null;
    return json(filePayload(detail!.file, envelope, envelope?.signers ?? [], ctx.baseUrl), created.existing ? 200 : 201);
  } catch (err) {
    return errorResponse(err);
  }
}

/** GET /api/v1/files?status=awaiting_signature */
export async function GET(request: Request) {
  try {
    const ctx = await apiCtx(request);
    const status = new URL(request.url).searchParams.get("status") as FileStatus | null;
    const rows = await listFiles(ctx, { status: status ?? "all", limit: 100 });
    return json({
      data: rows.map((f) => ({
        id: f.id,
        reference: f.reference,
        external_id: f.externalId,
        title: f.title,
        status: f.status,
        cleared_to_start: f.status === "signed",
        client: { name: f.clientName, email: f.clientEmail },
        created_at: f.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
