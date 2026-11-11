import { apiCtx, errorResponse } from "@/server/api";
import { blobResponse, getBlobMeta } from "@/server/blobs";
import { AppError } from "@/server/context";
import { getDb } from "@/server/db";
import { getFile } from "@/server/services/files";

export const runtime = "nodejs";

/** GET /api/v1/files/:id/agreement  returns the signed PDF once the file is signed. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await apiCtx(request);
    const detail = await getFile(ctx, decodeURIComponent((await params).id));
    if (!detail) throw new AppError("File not found.", "not_found", 404);
    const signed = detail.envelopes.find((e) => e.status === "completed" && e.signedBlobId);
    if (!signed) throw new AppError("This file has no signed agreement yet.", "not_signed", 409);
    const db = await getDb();
    const meta = await getBlobMeta(db, ctx.workspaceId, signed.signedBlobId!);
    if (!meta) throw new AppError("Document not found.", "not_found", 404);
    return blobResponse(db, meta, request, { filename: `${detail.file.reference} signed.pdf`, download: true });
  } catch (err) {
    return errorResponse(err);
  }
}
