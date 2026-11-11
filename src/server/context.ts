import { after } from "next/server";
import type { Actor } from "@/lib/types";

/** Who is acting, for which tenant. Every service function takes one. */
export interface Ctx {
  workspaceId: string;
  userId?: string;
  actor: Actor;
  /** Origin used to build signing links, for example https://app.example.com */
  baseUrl: string;
  ip?: string;
  userAgent?: string;
}

export class AppError extends Error {
  constructor(
    message: string,
    public code: string = "invalid",
    public status: number = 400,
  ) {
    super(message);
  }
}

export function envBaseUrl() {
  const explicit = process.env.APP_URL?.replace(/\/$/, "");
  if (explicit) return explicit;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

const pending = new Set<Promise<void>>();

/**
 * Run a side effect (email, webhook) after the response is sent.
 * Inside a Next.js request this uses after(), which keeps a serverless function alive
 * until the work finishes. Outside one (tests, scripts) it runs immediately and is
 * tracked so flushDeferred() can wait for it.
 */
export function defer(fn: () => Promise<void>) {
  const run = () =>
    fn().catch((err) => {
      console.error("[onfile] deferred task failed:", err);
    });
  try {
    after(run);
  } catch {
    const p = run();
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
}

export async function flushDeferred() {
  while (pending.size) await Promise.all([...pending]);
}
