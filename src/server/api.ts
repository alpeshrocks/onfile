import { ZodError } from "zod";
import { metaFromRequest } from "./auth";
import { AppError, type Ctx } from "./context";
import { getDb } from "./db";
import { workspaceFromApiKey } from "./services/accounts";
import { rateLimit } from "./webhooks";

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function errorResponse(err: unknown) {
  if (err instanceof AppError) return json({ error: { code: err.code, message: err.message } }, err.status);
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    return json({ error: { code: "invalid_request", message: issue?.message ?? "Invalid request", field: issue?.path.join(".") } }, 422);
  }
  console.error("[onfile] request failed:", err);
  return json({ error: { code: "internal", message: "Something went wrong on our side." } }, 500);
}

/** Authenticate a REST API call with a workspace API key (Authorization: Bearer onf_live_...). */
export async function apiCtx(request: Request): Promise<Ctx> {
  const header = request.headers.get("authorization") ?? "";
  const secret = header.replace(/^Bearer\s+/i, "").trim();
  const found = secret ? await workspaceFromApiKey(secret) : null;
  if (!found) throw new AppError("Missing or invalid API key. Send it as: Authorization: Bearer <key>", "unauthorized", 401);
  if (!(await rateLimit(await getDb(), `api:${found.key.id}`, 120, 60))) {
    throw new AppError("Rate limit exceeded: 120 requests per minute.", "rate_limited", 429);
  }
  const meta = metaFromRequest(request);
  return {
    workspaceId: found.workspace.id,
    actor: { kind: "api", name: `API key "${found.key.name}"` },
    baseUrl: meta.baseUrl,
    ip: meta.ip ?? undefined,
    userAgent: meta.userAgent ?? undefined,
  };
}
