import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { VerifyClient } from "@/components/verify-client";

export const metadata: Metadata = { title: "Verify a document" };

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const id = ((await searchParams).id ?? "").slice(0, 40);
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex h-[72px] max-w-[1120px] items-center px-5 sm:px-8">
        <Link href="/" aria-label="Onfile home">
          <Logo />
        </Link>
      </header>
      <main className="mx-auto max-w-2xl px-5 pt-8 pb-24">
        <h1 className="display text-[clamp(34px,5vw,48px)]">Check that a signed agreement is genuine</h1>
        <p className="mt-3 mb-8 text-[17px] leading-relaxed text-ink-2">
          Every agreement signed through Onfile has its fingerprint registered the moment signing finishes. If a copy has been altered in any way, it will not match.
        </p>
        <VerifyClient initialId={id} />
      </main>
    </div>
  );
}
