import type { Metadata } from "next";
import { ForgotForm } from "@/components/auth-forms";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPage() {
  return (
    <>
      <h1 className="display text-[36px]">Reset your password</h1>
      <p className="mt-2 mb-7 text-[15px] text-muted">Enter the email you sign in with and we will send a link to choose a new password.</p>
      <ForgotForm />
    </>
  );
}
