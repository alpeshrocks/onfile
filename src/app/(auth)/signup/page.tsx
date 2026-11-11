import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DemoButton, SignupForm } from "@/components/auth-forms";
import { getSession } from "@/server/auth";

export const metadata: Metadata = { title: "Create a workspace" };

export default async function SignupPage() {
  if (await getSession()) redirect("/dashboard");
  return (
    <>
      <h1 className="display text-[36px]">Create your workspace</h1>
      <p className="mt-2 mb-7 text-[15px] text-muted">Upload your agreement and send it on your first file in a few minutes.</p>
      <SignupForm />
      <div className="mt-8 border-t border-line pt-6 text-center">
        <p className="mb-3 text-sm text-muted">Just looking? Open a private sandbox with sample files, no account needed.</p>
        <DemoButton size="md" />
      </div>
    </>
  );
}
