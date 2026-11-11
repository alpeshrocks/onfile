import type { Metadata } from "next";
import { AutomationCard, FirmSignerCard, SettingsForm, TeamCard } from "@/components/settings-client";
import { PageHeader } from "@/components/ui";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { requireCtx } from "@/server/auth";
import { getWorkspace, listMembers } from "@/server/services/accounts";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { ctx, user } = await requireCtx();
  const [workspace, members] = await Promise.all([getWorkspace(ctx), listMembers(ctx)]);
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-6 xl:grid-cols-[1.3fr_1fr]">
        <SettingsForm name={workspace.name} brandColor={workspace.brandColor} settings={{ ...DEFAULT_SETTINGS, ...workspace.settings }} />
        <div className="space-y-6">
          <FirmSignerCard firmName={workspace.name} current={workspace.firmSigner ?? null} />
          <TeamCard members={members} currentUserId={user.id} isOwner={user.role === "owner"} />
          <AutomationCard />
        </div>
      </div>
    </>
  );
}
