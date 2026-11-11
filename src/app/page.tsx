import Link from "next/link";
import { DemoButton } from "@/components/auth-forms";
import { HeroDemo } from "@/components/hero-demo";
import { Logo } from "@/components/logo";
import { LinkButton } from "@/components/ui";
import { getSession } from "@/server/auth";

export const dynamic = "force-dynamic";

const STEPS = [
  {
    title: "Upload the agreement you already use",
    body: "A PDF, a Word document, even a scan. Onfile reads it, finds the signature lines, dates and blanks, and shows you what it found. You confirm it once.",
  },
  {
    title: "Open a file",
    body: "Type the client's name and email, import a spreadsheet, or let your case system do it through the API. The agreement goes out that second, with your firm's signature already on it.",
  },
  {
    title: "Start work when it says Signed",
    body: "Clients sign on their phone in about two minutes. Reminders chase the ones who do not. The signed PDF, with its certificate and audit trail, lands on the file.",
  },
];

const INSIDE = [
  ["Any agreement, never seen before", "Field detection reads underscores, form fields, placeholders and labels. If a document has no signature line at all, one click adds a signature page with the fields already placed."],
  ["Your firm signs once", "An authorized person adopts the firm's signature a single time. It is applied to every agreement as it is sent, and each use is written to that agreement's audit trail."],
  ["More than one signer", "Spouses, co-owners, business partners. Each gets a private link, and the file clears only when everyone has signed."],
  ["Follow-up that never forgets", "Reminders on the schedule you set, an expiry date, and a clear list of who opened the agreement but has not signed."],
  ["Proof that holds up", "A certificate of completion on every signed PDF, a hash-chained audit trail, and a public page where anyone can check that a copy is genuine."],
  ["Plugs into what you run", "A REST API and signed webhooks, so a file opened in your own system is sent for signature and reported back as cleared to start."],
  ["Works before email does", "Every message is kept in an Outbox, and every signer has a link and a QR code you can hand over directly."],
  ["Each firm on its own", "Workspaces are isolated from one another. Signing links are stored hashed, sessions are httpOnly, and passwords use scrypt."],
];

export default async function Home() {
  const session = await getSession();
  return (
    <div className="min-h-dvh bg-paper">
      <header className="mx-auto flex h-[72px] max-w-[1120px] items-center justify-between px-5 sm:px-8">
        <Link href="/" aria-label="Onfile home">
          <Logo />
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2">
          <LinkButton href="/verify" variant="ghost" size="sm" className="max-sm:hidden">
            Verify a document
          </LinkButton>
          {session ? (
            <LinkButton href="/dashboard" size="sm">
              Open workspace
            </LinkButton>
          ) : (
            <>
              <LinkButton href="/login" variant="ghost" size="sm">
                Sign in
              </LinkButton>
              <LinkButton href="/signup" size="sm">
                Create workspace
              </LinkButton>
            </>
          )}
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-[1120px] items-center gap-12 px-5 pt-10 pb-20 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:gap-16 lg:pt-16 lg:pb-28">
          <div>
            <h1 className="display text-[clamp(44px,7vw,78px)] leading-[0.98]">Every file signed before work starts.</h1>
            <p className="mt-6 max-w-[34rem] text-lg leading-relaxed text-ink-2">
              Onfile sends your client agreement the moment a file is opened, follows up until it is signed, and files a signed copy you can prove is genuine. Bring the agreement you already
              use.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <LinkButton href={session ? "/dashboard" : "/signup"} size="lg">
                {session ? "Open your workspace" : "Create your workspace"}
              </LinkButton>
              {!session && <DemoButton />}
            </div>
            <p className="mt-4 text-sm text-muted">Free to try. The sample workspace needs no account.</p>
          </div>
          <HeroDemo />
        </section>

        <section className="border-y border-line bg-surface">
          <div className="mx-auto max-w-[1120px] px-5 py-20 sm:px-8">
            <h2 className="display max-w-2xl text-[clamp(30px,4vw,44px)]">Set it up once. After that, opening a file is the only step.</h2>
            <ol className="mt-12 grid gap-10 lg:grid-cols-3 lg:gap-12">
              {STEPS.map((step, i) => (
                <li key={step.title} className="relative">
                  <span className="display tabular block text-[56px] leading-none text-blue">{i + 1}</span>
                  <h3 className="mt-4 text-[19px] font-semibold">{step.title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mx-auto max-w-[1120px] px-5 py-20 sm:px-8">
          <h2 className="display max-w-2xl text-[clamp(30px,4vw,44px)]">What a firm gets on day one</h2>
          <dl className="mt-10 grid gap-x-16 sm:grid-cols-2">
            {INSIDE.map(([title, body]) => (
              <div key={title} className="border-t border-line py-6">
                <dt className="text-[17px] font-semibold">{title}</dt>
                <dd className="mt-1.5 text-[15px] leading-relaxed text-ink-2">{body}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="bg-ink text-white">
          <div className="mx-auto flex max-w-[1120px] flex-wrap items-center justify-between gap-8 px-5 py-16 sm:px-8">
            <div>
              <h2 className="display text-[clamp(30px,4vw,44px)]">Have your agreement ready?</h2>
              <p className="mt-3 max-w-xl text-[17px] leading-relaxed text-white/75">Upload it, confirm the fields, and send it on a real file. The whole setup fits inside a coffee break.</p>
            </div>
            <LinkButton href={session ? "/agreements" : "/signup"} size="lg" variant="flag">
              {session ? "Upload an agreement" : "Create your workspace"}
            </LinkButton>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-[1120px] flex-wrap items-center justify-between gap-4 px-5 py-8 text-[13px] text-muted sm:px-8">
        <p>Onfile. Electronic signatures under the U.S. ESIGN Act and UETA.</p>
        <nav className="flex gap-5">
          <Link href="/verify" className="hover:text-ink hover:underline">
            Verify a document
          </Link>
          <Link href="/login" className="hover:text-ink hover:underline">
            Sign in
          </Link>
        </nav>
      </footer>
    </div>
  );
}
