import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth-forms";
import { getSession } from "@/server/auth";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getSession()) redirect("/dashboard");
  return (
    <>
      <h1 className="display text-[36px]">Sign in</h1>
      <p className="mt-2 mb-7 text-[15px] text-muted">Open your firm&apos;s workspace.</p>
      <LoginForm />
    </>
  );
}
