# Submission: Onfile

- **Submission URL:** _add after deploying_
- **GitHub repository:** _add after pushing_

## 1. What I built

**Onfile gets the client agreement signed on every file, without anyone having to remember
to send it.**

The client's sentence had three parts, and I built to all three:

| What the client said | What that became |
| --- | --- |
| "has to sign the same agreement before we can start work" | One agreement, set up once, is the default for every file. A file is blocked until it is signed, then marked **Cleared to start**. |
| "that is manual, and it slows down every file" | Opening a file is the only action. Sending, the firm's own signature, reminders, expiry, filing the signed copy and telling the firm all happen on their own. Files can also be opened by spreadsheet import or by the firm's own system through an API. |
| "sell it to every other company in our industry" | Multi-tenant from the start: any firm can sign up, upload its own agreement, brand its emails and invite its team, on the same deployment. |

The hard constraint was that the agreement is unknown in advance. So nothing about any
particular document is built in. A firm uploads whatever it has (PDF, Word, a scan or photo,
plain text). Onfile reads it, proposes where the signature, date, name and other fields go and
who fills each one, and a person confirms that proposal once. If a document gives it nothing
to work with, one click appends a signature page whose fields are already in place, so there
is always a path from "any document" to "signable".

### The flow, end to end

1. **Set up once.** Upload the agreement. Review the detected fields in a visual editor
   (drag, resize, reassign, add). Adopt the firm's signature once. Publish.
2. **Open a file.** Client name and email, plus any values the agreement needs (a fee, an
   address). The agreement is sent that second, already signed by the firm.
3. **The client signs.** A private link, no account, built for a phone: consent to sign
   electronically, a guided "next field" flow, draw or type a signature, finish.
4. **The file clears.** The signed PDF has every value stamped in place, a document ID on
   each page and a certificate of completion with the audit trail. Both sides get a copy. The
   firm's system is notified by webhook.
5. **Nobody chases.** Reminders go out on a schedule, stale requests expire, and the overview
   shows who opened the agreement but has not signed.

## 2. Features I included, and why

**Getting an unseen agreement ready**

- **Any-format upload.** PDFs are kept exactly as they are. Word, text and images are
  converted to PDF. Why: I do not know what form the MIND agreement arrives in, and a firm
  should never be told to go and convert a file first.
- **Automatic field detection, confirmed by a person.** Finds form fields, blank lines with
  labels beside or under them, placeholders like `[Client Name]`, and labels printed under
  drawn rules; decides client versus firm from the words around each field. Why: placing
  fields by hand is the single biggest setup cost in e-signature tools, and it is the step
  most likely to be done wrong. Detection does the work; the person only checks it.
- **One-click signature page.** Why: a guaranteed fallback for scans and for agreements with
  no signature line. No document can leave a firm stuck.
- **Visual editor with a live checklist.** Why: the person must be able to fix anything
  detection got wrong, and must be told plainly what still blocks publishing.
- **In-browser repair for protected or damaged PDFs.** Why: "your PDF is not supported" is a
  dead end; rebuilding it from rendered pages is not.

**Taking the manual work out of every file**

- **Send on file creation.** Why: this is the automation the client asked for. There is no
  separate "send" step to forget.
- **Standing firm signature.** An authorized person signs once; it is applied to each
  agreement and recorded in that agreement's audit trail. Why: if the firm has to countersign
  every file, the process is still manual.
- **Automatic fields and custom values.** Client name, file reference, dates, firm details,
  and firm-defined values are printed onto the agreement per file. Why: "the same agreement"
  almost always has a few blanks that differ by file.
- **Reminders and expiry on a schedule.** Why: chasing signatures is the other half of the
  manual work.
- **Spreadsheet import.** Why: on day one a firm has a backlog of open files; they should all
  go through signing in one go.
- **REST API and signed webhooks.** Why: a firm that already has a case system should never
  open a file twice. Idempotent on the firm's own ID, so retries are safe.
- **More than one signer.** Why: spouses, co-owners and business partners are routine; the
  file clears only when all have signed.

**A signature a firm can rely on**

- **Consent, intent, record, copy.** Explicit consent to electronic signing before the
  document opens, a deliberate signing act, a final confirmation, and a signed copy to every
  party. Why: these are the elements of a valid electronic signature under the U.S. ESIGN Act
  (15 U.S.C. 7001 et seq.) and UETA.
- **Certificate of completion and hash-chained audit trail.** Who did what, when, from which
  IP and device; each event commits to the one before it. Why: when a signature is disputed,
  this is the evidence.
- **Public verification page.** Drop a PDF to check it is byte-for-byte what was signed. The
  file is hashed in the browser and never uploaded. Why: a client or a third party should be
  able to trust a copy without trusting whoever sent it.
- **Decline and void, with reasons.** Why: real files do not all end in a signature, and a
  blocked file needs a clear next step.

**Ready to sell to the next firm**

- **Multi-tenant workspaces, team invitations, branding, time zone.** Why: the client's stated
  goal is to sell this to other firms; it should not need rebuilding to do so.
- **Sample workspace in one click.** A private sandbox with realistic history, produced by
  running the real send, open, sign and decline code. Why: a prospect (or a reviewer) should
  be able to judge the product before uploading anything.
- **Outbox, copyable link and QR code.** Every email is kept and viewable; every signer has a
  link that can be handed over directly. Why: signing must work before email deliverability
  is set up, and staff often want to say "scan this" to a client sitting across the desk.

**Engineering that supports the above**

- 48 automated tests, including field detection and PDF stamping checked against real
  generated PDFs (rotated pages, offset crop boxes, form fields, two-column signature
  blocks), the full lifecycle against a real Postgres engine, tenant isolation, and the API
  with HMAC-verified webhooks.
- Zero-configuration local run (embedded Postgres), CI workflow, health endpoint.

## 3. Features I deliberately left out, and why

- **AI or LLM field detection.** Detection is deterministic rules plus human confirmation.
  A signing product has to behave the same way twice, and agreement text should not be sent
  to a third party by default. It would also have made the test of this submission depend on
  an external API key. An optional LLM assist for the low-confidence cases is the natural
  next step; the engine already reports confidence per field.
- **Certificate-based digital signatures (PAdES, a trusted timestamp authority).** These need
  a signing certificate from a recognized authority and key custody. I chose tamper evidence
  that needs none of that: a registered SHA-256 fingerprint, a hash-chained audit trail and a
  public verification page. This is the level most engagement agreements are signed at.
- **Stronger signer identity checks (SMS codes, ID documents, knowledge questions).** The
  private emailed link plus IP, device and timestamps is the common baseline for a client
  agreement. Stronger checks add cost and friction per signature and should be a per-firm
  option, not a default.
- **Billing, plans and usage limits.** Needed to sell it, but they do not change whether the
  product does its job, and pricing is a business decision the client has not made. Tenancy
  is in place, so billing can be attached to a workspace later.
- **Built-in connectors for specific case-management products.** I do not know which systems
  this industry uses. A REST API, signed webhooks and spreadsheet import cover every one of
  them, including through tools such as Zapier or Make, without guessing.
- **Signing order, witnesses and notarization.** All signers get their links at once. Ordered
  routing matters for approvals; for one agreement between a firm and its client it adds
  delay.
- **Fine-grained roles and single sign-on.** There are owners and members. Per-file access
  rules and SSO are for larger customers than the first one.
- **Text messages.** Email plus a copyable link and QR code covers delivery. SMS means a
  paid provider and consent rules for each country.
- **Editing the agreement's wording, redlining, negotiation.** The brief is "the same
  agreement on every file". Onfile gets it signed; it does not draft it.
- **Reading drawn lines from PDF graphics.** Detection uses the text layer and form fields.
  Agreements whose lines are drawn rules are handled through their labels, and the signature
  page covers the rest.
- **A job queue with retries.** Emails and webhooks run right after each action, and failures
  are logged and visible. Retrying failed webhook deliveries automatically is the first thing
  I would add under real load.
- **Object storage (S3).** Documents are stored in Postgres, which keeps one datastore and one
  transaction boundary. Storage is behind one small module and can be swapped when volume
  justifies it.
- **Dark mode and translations.** One polished theme in English, rather than two half-done.

## 4. Decisions where the brief was open

- **Which industry.** Not stated. I assumed firms that work per case or job and need a
  signed agreement before starting (claims, legal, restoration, consulting and similar). The
  product uses only neutral words: file, client, agreement, firm.
- **"The same agreement."** One default agreement per firm, sent automatically. A firm can
  keep several and choose per file.
- **Who signs for the firm.** A standing signature applied automatically, with each use
  recorded. A firm that wants no firm signature simply leaves those fields out.
- **When is a file "started".** Onfile does not run the work itself. It reports
  `cleared_to_start` on the file, in the API and by webhook, so the firm's own process can
  gate on it.
- **Email.** Deliverability needs a verified sending domain, which a test deployment may not
  have. So email is optional: with a provider key it sends; without one, messages are held in
  the Outbox and the signing link is shown, copyable and as a QR code. The flow can always be
  completed.
- **Legal scope.** Built to U.S. ESIGN and UETA requirements for simple electronic
  signatures. It is not legal advice, and it does not claim qualified signature status under
  eIDAS.
- **Data.** Test data only. All seeded names are fictional and use example.com addresses.

## 5. Tools used

- **Languages and frameworks:** TypeScript, Next.js 15 (App Router), React 19, Tailwind CSS 4.
- **Data:** Postgres through Drizzle ORM; PGlite (Postgres in WASM) for local runs and tests.
- **Documents:** pdf-lib (stamping, certificate, typesetting), pdf.js (rendering and text
  extraction), mammoth (Word to HTML).
- **Other libraries:** Zod, lucide-react, sonner, qrcode.
- **Testing and quality:** Vitest, ESLint, TypeScript strict mode, GitHub Actions.
- **Services:** Vercel (hosting and cron), Neon (Postgres), Resend (optional email).
- **AI assistant:** Claude Code (Anthropic) was used throughout for design, implementation,
  testing and review.

## 6. How to test it

1. Open the submission URL. Choose **Create your workspace** (or **Explore a sample
   workspace** to look around first).
2. Upload the MIND client agreement on the welcome screen.
3. In the editor, check the proposed fields. If the firm signs too, choose **Set up firm
   signature**. If no signature line was found, choose **Add a signature page**. Publish.
4. Choose **Open your first file**, enter a client name and email, and send.
5. On the file page, use **Sign on this device**, copy the link, or scan the QR code.
6. Sign. The file shows **Cleared to start**; download the signed agreement and drop it on
   **Verify a document**.
