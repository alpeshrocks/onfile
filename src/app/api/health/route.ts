import { sql } from "drizzle-orm";
import { json } from "@/server/api";
import { getDb } from "@/server/db";
import { emailConfigured } from "@/server/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    return json({ status: "ok", database: process.env.DATABASE_URL ? "postgres" : "pglite", email: emailConfigured() ? "resend" : "outbox" });
  } catch (err) {
    return json({ status: "error", message: err instanceof Error ? err.message : "database unavailable" }, 503);
  }
}
