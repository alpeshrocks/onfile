import type { Metadata } from "next";
import Link from "next/link";
import { ResetForm } from "@/components/auth-forms";
import { findReset } from "@/server/services/accounts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Choose a new password", robots: { index: false } };

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const found = await findReset(token);
  if (!found) {
    return (
      <>
        <h1 className="display text-[32px]">This reset link is no longer valid</h1>
        <p className="mt-3 text-[15px] text-muted">Reset links work once and expire after an hour.</p>
        <Link href="/forgot" className="mt-5 inline-block text-sm font-semibold text-blue hover:underline">
          Request a new link
        </Link>
      </>
    );
  }
  return (
    <>
      <h1 className="display text-[36px]">Choose a new password</h1>
      <p className="mt-2 mb-7 text-[15px] text-muted">Hello {found.name.split(" ")[0]}. Once saved, you will be signed out everywhere else.</p>
      <ResetForm token={token} />
    </>
  );
}
