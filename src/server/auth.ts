import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { Ctx } from "./context";
import { SESSION_DAYS, sessionFromToken } from "./services/accounts";

const COOKIE = "onfile_session";

export const getSession = cache(async () => {
  const token = (await cookies()).get(COOKIE)?.value;
  return sessionFromToken(token);
});

export async function sessionToken() {
  return (await cookies()).get(COOKIE)?.value;
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(COOKIE);
}

/** Origin, IP and user agent of the current request. */
export async function requestMeta() {
  const h = await headers();
  const explicit = process.env.APP_URL?.replace(/\/$/, "");
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto")?.split(",")[0] ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return {
    baseUrl: explicit || `${proto}://${host}`,
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null,
    userAgent: h.get("user-agent"),
  };
}

export function metaFromRequest(request: Request) {
  const h = request.headers;
  const explicit = process.env.APP_URL?.replace(/\/$/, "");
  const url = new URL(request.url);
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? url.host;
  const proto = h.get("x-forwarded-proto")?.split(",")[0] ?? url.protocol.replace(":", "");
  return {
    baseUrl: explicit || `${proto}://${host}`,
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null,
    userAgent: h.get("user-agent"),
  };
}

/** For pages and server actions: the signed-in user's context, or a redirect to sign in. */
export async function requireCtx() {
  const session = await getSession();
  if (!session) redirect("/login");
  const meta = await requestMeta();
  const ctx: Ctx = {
    workspaceId: session.workspace.id,
    userId: session.user.id,
    actor: { kind: "user", name: session.user.name, email: session.user.email },
    baseUrl: meta.baseUrl,
    ip: meta.ip ?? undefined,
    userAgent: meta.userAgent ?? undefined,
  };
  return { ctx, user: session.user, workspace: session.workspace };
}

/** For route handlers: same as requireCtx but returns null instead of redirecting. */
export async function optionalCtx(request: Request) {
  const session = await getSession();
  if (!session) return null;
  const meta = metaFromRequest(request);
  const ctx: Ctx = {
    workspaceId: session.workspace.id,
    userId: session.user.id,
    actor: { kind: "user", name: session.user.name, email: session.user.email },
    baseUrl: meta.baseUrl,
    ip: meta.ip ?? undefined,
    userAgent: meta.userAgent ?? undefined,
  };
  return { ctx, user: session.user, workspace: session.workspace };
}
