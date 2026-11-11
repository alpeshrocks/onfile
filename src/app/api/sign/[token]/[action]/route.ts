import { errorResponse, json } from "@/server/api";
import { metaFromRequest } from "@/server/auth";
import { blobResponse, getBlobMeta } from "@/server/blobs";
import { AppError } from "@/server/context";
import { getDb } from "@/server/db";
import { declineSigning, recordConsent, recordView, signingDocument, submitSigning } from "@/server/services/signing";
import { rateLimit } from "@/server/webhooks";

export const runtime = "nodejs";
export const maxDuration = 60;

type Params = { params: Promise<{ token: string; action: string }> };

/** The signer's token in the path is the credential. No account, no cookie. */
export async function GET(request: Request, { params }: Params) {
  try {
    const { token, action } = await params;
    if (action !== "document" && action !== "signed") throw new AppError("Not found.", "not_found", 404);
    const doc = await signingDocument(token, action === "signed" ? "signed" : "source");
    const meta = doc ? await getBlobMeta(doc.db, doc.workspaceId, doc.blobId) : null;
    if (!doc || !meta) throw new AppError("Document not available.", "not_found", 404);
    const filename = `${doc.envelope.templateName}${action === "signed" ? " (signed)" : ""}.pdf`;
    return blobResponse(doc.db, meta, request, { filename, download: action === "signed", cache: "private, no-store" });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { token, action } = await params;
    const meta = metaFromRequest(request);
    if (!(await rateLimit(await getDb(), `sign:${meta.ip ?? token.slice(0, 12)}`, 60, 60))) {
      throw new AppError("Too many requests. Wait a moment and try again.", "rate_limited", 429);
    }
    switch (action) {
      case "view":
        await recordView(token, meta);
        return json({ ok: true });
      case "consent":
        await recordConsent(token, meta);
        return json({ ok: true });
      case "submit":
        return json(await submitSigning(token, await request.json(), meta));
      case "decline": {
        const body = (await request.json().catch(() => ({}))) as { reason?: string };
        await declineSigning(token, String(body.reason ?? ""), meta);
        return json({ ok: true });
      }
      default:
        throw new AppError("Not found.", "not_found", 404);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
