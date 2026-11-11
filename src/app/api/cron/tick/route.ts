import { errorResponse, json } from "@/server/api";
import { metaFromRequest } from "@/server/auth";
import { AppError } from "@/server/context";
import { safeEqual } from "@/server/crypto";
import { getDb } from "@/server/db";
import { runAutomation } from "@/server/services/automation";
import { rateLimit } from "@/server/webhooks";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Daily automation tick: reminders and expiry. Vercel Cron calls this with
 * Authorization: Bearer $CRON_SECRET. The job is idempotent, so when no secret is
 * configured it stays callable but is throttled instead of being left broken.
 */
export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (secret) {
      if (!safeEqual(given, secret)) throw new AppError("Unauthorized.", "unauthorized", 401);
    } else if (!(await rateLimit(await getDb(), "cron:open", 4, 600))) {
      throw new AppError("Throttled.", "rate_limited", 429);
    }
    return json(await runAutomation(metaFromRequest(request).baseUrl));
  } catch (err) {
    return errorResponse(err);
  }
}
