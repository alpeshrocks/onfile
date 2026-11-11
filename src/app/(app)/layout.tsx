import { and, eq, sql } from "drizzle-orm";
import { AppNav } from "@/components/app-nav";
import { requireCtx } from "@/server/auth";
import { getDb } from "@/server/db";
import { files } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { ctx, user, workspace } = await requireCtx();
  const db = await getDb();
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(files)
    .where(and(eq(files.workspaceId, ctx.workspaceId), eq(files.status, "awaiting_signature")));

  return (
    <div className="min-h-dvh">
      <AppNav workspace={workspace.name} user={user.name} awaiting={n} />
      <div className="lg:pl-[232px]">
        {workspace.isDemo && (
          <div className="border-b border-flag-ink/10 bg-flag-50 px-4 py-2 text-center text-[13px] text-flag-ink">
            This is a sample workspace with fictional clients. Everything works: open a file, sign it, download the record.
          </div>
        )}
        <main className="mx-auto w-full max-w-[1120px] px-4 py-8 sm:px-8 sm:py-10">{children}</main>
      </div>
    </div>
  );
}
