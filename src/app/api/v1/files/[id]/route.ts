import { apiCtx, errorResponse, json } from "@/server/api";
import { AppError } from "@/server/context";
import { filePayload, getFile } from "@/server/services/files";

export const runtime = "nodejs";

/** GET /api/v1/files/:id  (id may be the Onfile id, your reference, or your external_id) */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await apiCtx(request);
    const detail = await getFile(ctx, decodeURIComponent((await params).id));
    if (!detail) throw new AppError("File not found.", "not_found", 404);
    const envelope = detail.envelopes[0] ?? null;
    return json(filePayload(detail.file, envelope, envelope?.signers ?? [], ctx.baseUrl));
  } catch (err) {
    return errorResponse(err);
  }
}
