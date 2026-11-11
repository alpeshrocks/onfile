import { and, asc, eq, lt } from "drizzle-orm";
import { errorResponse, json } from "@/server/api";
import { optionalCtx } from "@/server/auth";
import { AppError } from "@/server/context";
import { getDb } from "@/server/db";
import { uploadChunks } from "@/server/db/schema";
import { ingestDocument, MAX_UPLOAD_BYTES } from "@/server/services/templates";

export const runtime = "nodejs";
export const maxDuration = 60;

const CHUNK_LIMIT = 3.5 * 1024 * 1024;

/**
 * Chunked upload. The browser sends an agreement in pieces of about 3 MB, so large scans
 * get through hosts that cap request bodies (Vercel: 4.5 MB). The last piece triggers
 * assembly, conversion to PDF if needed, and creation of a draft agreement.
 */
export async function POST(request: Request) {
  try {
    const session = await optionalCtx(request);
    if (!session) throw new AppError("Sign in to upload.", "unauthorized", 401);
    const { ctx } = session;
    const url = new URL(request.url);
    const uploadId = url.searchParams.get("uploadId") ?? "";
    const index = Number(url.searchParams.get("index"));
    const total = Number(url.searchParams.get("total"));
    const name = (url.searchParams.get("name") ?? "agreement.pdf").slice(0, 200);
    if (!/^[A-Za-z0-9_-]{8,48}$/.test(uploadId) || !Number.isInteger(index) || !Number.isInteger(total) || index < 0 || total < 1 || total > 10 || index >= total) {
      throw new AppError("Malformed upload request.");
    }
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength === 0) throw new AppError("That file is empty.");
    if (body.byteLength > CHUNK_LIMIT) throw new AppError("Upload piece too large.", "too_large", 413);

    const db = await getDb();
    if (total === 1) {
      return json(await ingestDocument(ctx, { bytes: body, filename: name }));
    }
    if (index === 0) {
      // Sweep abandoned uploads.
      await db.delete(uploadChunks).where(lt(uploadChunks.createdAt, new Date(Date.now() - 3_600_000)));
    }
    await db
      .insert(uploadChunks)
      .values({ uploadId, workspaceId: ctx.workspaceId, idx: index, data: body })
      .onConflictDoUpdate({ target: [uploadChunks.uploadId, uploadChunks.idx], set: { data: body } });
    if (index < total - 1) return json({ received: index });

    const mine = and(eq(uploadChunks.uploadId, uploadId), eq(uploadChunks.workspaceId, ctx.workspaceId));
    const parts = await db.select().from(uploadChunks).where(mine).orderBy(asc(uploadChunks.idx));
    await db.delete(uploadChunks).where(mine);
    if (parts.length !== total) throw new AppError("The upload was incomplete. Try again.", "incomplete", 409);
    const size = parts.reduce((n, p) => n + p.data.byteLength, 0);
    if (size > MAX_UPLOAD_BYTES) throw new AppError("Files can be up to 25 MB.", "too_large", 413);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const p of parts) {
      bytes.set(p.data, offset);
      offset += p.data.byteLength;
    }
    return json(await ingestDocument(ctx, { bytes, filename: name }));
  } catch (err) {
    return errorResponse(err);
  }
}
