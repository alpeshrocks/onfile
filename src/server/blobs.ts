import { and, eq, sql } from "drizzle-orm";
import { newId, sha256Hex } from "./crypto";
import type { DbOrTx } from "./db";
import { blobs } from "./db/schema";

export async function putBlob(db: DbOrTx, workspaceId: string, data: Uint8Array, contentType: string) {
  const id = newId("blob");
  const sha256 = sha256Hex(data);
  await db.insert(blobs).values({ id, workspaceId, sha256, size: data.byteLength, contentType, data });
  return { id, sha256, size: data.byteLength };
}

export async function getBlob(db: DbOrTx, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(blobs)
    .where(and(eq(blobs.id, id), eq(blobs.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export async function getBlobMeta(db: DbOrTx, workspaceId: string, id: string) {
  const [row] = await db
    .select({ id: blobs.id, size: blobs.size, sha256: blobs.sha256, contentType: blobs.contentType })
    .from(blobs)
    .where(and(eq(blobs.id, id), eq(blobs.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** Read a byte range straight from Postgres, so large PDFs never sit fully in memory. */
export async function readBlobRange(db: DbOrTx, id: string, start: number, length: number): Promise<Uint8Array> {
  const [row] = await db
    .select({ part: sql<Uint8Array>`substring(${blobs.data} from ${start + 1} for ${length})` })
    .from(blobs)
    .where(eq(blobs.id, id))
    .limit(1);
  const part = row?.part;
  if (!part) return new Uint8Array();
  return part instanceof Uint8Array ? part : new Uint8Array(part as ArrayBuffer);
}

const SLICE = 512 * 1024;

/**
 * HTTP response for a stored document with Range support.
 * pdf.js uses ranges to show page one before the whole file has arrived, and streaming
 * keeps responses under serverless payload limits regardless of document size.
 */
export async function blobResponse(
  db: DbOrTx,
  meta: { id: string; size: number; sha256: string; contentType: string },
  request: Request,
  opts: { filename?: string; download?: boolean; cache?: string } = {},
): Promise<Response> {
  const headers = new Headers({
    "Content-Type": meta.contentType,
    "Accept-Ranges": "bytes",
    ETag: `"${meta.sha256}"`,
    "Cache-Control": opts.cache ?? "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
  });
  if (opts.filename) {
    const safe = opts.filename.replace(/[^\w.\- ]+/g, "_");
    headers.set("Content-Disposition", `${opts.download ? "attachment" : "inline"}; filename="${safe}"`);
  }

  let start = 0;
  let end = meta.size - 1;
  let status = 200;
  const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
    } else {
      start = Math.max(0, meta.size - Number(range[2]));
    }
    if (start > end || start >= meta.size) {
      headers.set("Content-Range", `bytes */${meta.size}`);
      return new Response(null, { status: 416, headers });
    }
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${meta.size}`);
  }
  headers.set("Content-Length", String(end - start + 1));
  if (request.method === "HEAD") return new Response(null, { status, headers });

  let cursor = start;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cursor > end) return controller.close();
      const length = Math.min(SLICE, end - cursor + 1);
      const part = await readBlobRange(db, meta.id, cursor, length);
      if (!part.byteLength) return controller.close();
      cursor += part.byteLength;
      controller.enqueue(part);
    },
  });
  return new Response(stream, { status, headers });
}
