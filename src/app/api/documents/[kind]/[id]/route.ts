import { and, eq } from "drizzle-orm";
import { errorResponse } from "@/server/api";
import { optionalCtx } from "@/server/auth";
import { blobResponse, getBlobMeta } from "@/server/blobs";
import { AppError } from "@/server/context";
import { getDb } from "@/server/db";
import { envelopes, files, templates } from "@/server/db/schema";

export const runtime = "nodejs";

/** Staff access to documents: a template's PDF, an agreement as sent, or the signed record. */
export async function GET(request: Request, { params }: { params: Promise<{ kind: string; id: string }> }) {
  try {
    const { kind, id } = await params;
    const session = await optionalCtx(request);
    if (!session) throw new AppError("Sign in to view this document.", "unauthorized", 401);
    const { ctx } = session;
    const db = await getDb();
    let blobId: string | null = null;
    let filename = "agreement.pdf";

    if (kind === "template") {
      const [t] = await db.select().from(templates).where(and(eq(templates.id, id), eq(templates.workspaceId, ctx.workspaceId))).limit(1);
      blobId = t?.blobId ?? null;
      filename = `${t?.name ?? "agreement"}.pdf`;
    } else if (kind === "source" || kind === "signed") {
      const [e] = await db.select().from(envelopes).where(and(eq(envelopes.id, id), eq(envelopes.workspaceId, ctx.workspaceId))).limit(1);
      if (e) {
        const [f] = await db.select({ reference: files.reference }).from(files).where(eq(files.id, e.fileId)).limit(1);
        blobId = kind === "signed" ? e.signedBlobId : e.sourceBlobId;
        filename = `${f?.reference ?? "file"} ${e.templateName}${kind === "signed" ? " (signed)" : ""}.pdf`;
      }
    }
    const meta = blobId ? await getBlobMeta(db, ctx.workspaceId, blobId) : null;
    if (!meta) throw new AppError("Document not found.", "not_found", 404);
    const download = new URL(request.url).searchParams.has("download");
    return blobResponse(db, meta, request, { filename, download });
  } catch (err) {
    return errorResponse(err);
  }
}
