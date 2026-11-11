import type { Metadata } from "next";
import { SigningExperience } from "@/components/signing-experience";
import { getSigningView } from "@/server/services/signing";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign your agreement", robots: { index: false, follow: false } };

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await getSigningView(token);
  if (!view) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
        <h1 className="display text-[32px]">This signing link is not valid</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          The link may be incomplete. Open it again from the email you received, or ask the firm that sent it for a new one.
        </p>
      </main>
    );
  }
  return <SigningExperience token={token} view={view} />;
}
