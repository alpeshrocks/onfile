import type { Metadata } from "next";
import { JoinForm } from "@/components/auth-forms";
import { findInvite } from "@/server/services/accounts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Join a workspace", robots: { index: false } };

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await findInvite(token);
  if (!invite) {
    return (
      <>
        <h1 className="display text-[32px]">This invitation is no longer valid</h1>
        <p className="mt-3 text-[15px] text-muted">Invitations work once and expire after seven days. Ask a teammate for a new link.</p>
      </>
    );
  }
  return (
    <>
      <h1 className="display text-[36px]">Join {invite.workspace.name}</h1>
      <p className="mt-2 mb-7 text-[15px] text-muted">Create your sign-in to open files and track agreements with your team.</p>
      <JoinForm token={token} />
    </>
  );
}
