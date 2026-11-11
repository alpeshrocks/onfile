# Onfile

**Every file signed before work starts.**

Onfile automates getting a client agreement signed on every file. A firm uploads the
agreement it already uses, confirms the fields Onfile finds in it, and from then on opening a
file is the only step: the agreement goes out, reminders follow, and a signed PDF with a
certificate and audit trail lands on the file. Work is "cleared to start" only when everyone
has signed.

It is multi-tenant from the first line, so the same deployment serves every firm that signs up.

See [SUBMISSION.md](SUBMISSION.md) for the product decisions: what is included, what was
deliberately left out, and why.

## Try it in three minutes

1. Open the app and choose **Explore a sample workspace** (no account), or create a workspace.
2. **Agreements**: upload any agreement (PDF, Word, scan, text). Onfile proposes the fields.
   Adjust if needed, set up the firm signature when prompted, then **Publish**.
3. **Files, Open a file**: enter a client name and email. The agreement is sent immediately.
4. Open the private signing link (copy it, scan the QR code, or use the email), sign, finish.
5. Back on the file: **Cleared to start**, signed PDF, certificate, audit trail. Check the PDF
   on **Verify a document**.

## Run it locally

Requires Node 20 or newer. Nothing else: no database to install, no accounts, no API keys.

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:3000.

With no configuration Onfile uses an embedded Postgres (PGlite, stored in `./.data`) and keeps
every outgoing email in the in-app Outbox instead of sending it.

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm test` | 57 tests: unit, real-PDF detection and stamping, full lifecycle, signer correction, password reset, REST API and webhooks |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, strict |
| `npm run build` | Production build |
| `npm run db:generate` | Regenerate SQL migrations after editing `src/server/db/schema.ts` |

## How it works

```
 Firm staff / case system                    Client (any device, no account)
        |                                               ^
        | open a file (UI, CSV, REST API)               | private signing link
        v                                               |
 +--------------+   snapshot template   +----------------------------+
 |  File        | --------------------> |  Envelope (one sending)    |
 |  one job or  |   resolve automatic   |  fields + values, signers, |
 |  case        |   fields, firm        |  hash-chained audit trail  |
 +--------------+   signature, links    +----------------------------+
        ^                                               |
        | status: signed = cleared to start             | all signers done
        |                                               v
        |                               +----------------------------+
        +------------------------------ |  Finalize: stamp PDF,      |
          signed PDF, emails, webhooks  |  append certificate, hash, |
                                        |  register fingerprint      |
                                        +----------------------------+
```

- **Template**: an agreement PDF plus the fields laid over it. Fields belong to a signer role
  (client, co-signer) or are **automatic** (filled when the agreement is sent: the firm's
  signature, dates, the client's name, custom values such as a fee).
- **File**: one job or case for one client.
- **Envelope**: one sending of a template for one file. It snapshots the fields, so editing a
  template never changes an agreement that is already out.

### Handling an agreement it has never seen

1. **Any format in.** PDFs are stored byte for byte. Word (.docx), plain text and images are
   converted to PDF by a small typesetter. PDFs that cannot be stamped (encrypted, malformed)
   can be rebuilt in the browser from rendered pages.
2. **Field detection** (`src/lib/detect.ts`). A deterministic engine reads positioned text
   from pdf.js and proposes fields from: real PDF form fields; underscore or dot-leader blanks
   labelled beside or beneath; placeholder tokens such as `[Client Name]`; and labels printed
   next to or under drawn rules. It assigns each field to the client, a co-signer or the firm
   by reading the surrounding words. It runs in the browser, so document text never leaves
   the session, and in the test suite against real generated PDFs.
3. **A person confirms.** The editor shows the proposal, marks low-confidence guesses, and
   keeps a live checklist of what blocks publishing. **Preview as client** walks through the real
   signing screens with sample data before anything is published; nothing is sent or saved.
4. **A guaranteed path.** If nothing can be detected (a scan, an agreement with no signature
   line), one click appends a signature page whose fields are already placed.

## Engineering notes

- **One schema, two Postgres engines.** `DATABASE_URL` set: node-postgres against any
  Postgres. Unset: PGlite (Postgres compiled to WASM). Development, CI and tests run the same
  SQL dialect as production. Migrations are generated by drizzle-kit, bundled as code and
  applied on first use under an advisory lock, so a fresh deploy needs no migrate step.
- **Coordinates are tested against an independent judge.** Fields are stored normalized to
  the page as displayed. `src/lib/geometry.ts` maps that to PDF user space for rotations of
  0, 90, 180 and 270 degrees and offset crop boxes. The tests stamp a value with pdf-lib,
  re-read the PDF with pdf.js (which shares no code with the stamper) and assert the text is
  where the field was placed.
- **Tamper evidence in three layers.** The signed PDF's SHA-256 is registered at completion
  and checked on the public verify page (the file is hashed in the browser and never
  uploaded). Every audit event stores the hash of the previous one, so the trail is a chain
  that breaks if a row is edited. Signing refuses to complete if the chain does not verify.
- **Signatures are vectors.** Drawn signatures are stored as strokes and rendered by one path
  builder for both the screen and the PDF, so they stay sharp at any size and add a few
  hundred bytes instead of an image.
- **Names never break a signature.** Text is drawn with the standard PDF fonts when they can
  encode it and falls back to a bundled Unicode font (DejaVu) when they cannot.
- **Time is injectable.** All business logic reads a clock that tests and the demo seeder can
  set (`src/server/clock.ts`). Reminder schedules and expiry are tested through the real code
  path with no sleeping, and the sample workspace has real history with an intact audit chain.
- **Side effects after commit.** Database changes for one action happen in one transaction
  under a row lock on the envelope. Emails and webhooks run afterwards via `after()`, so a slow
  mail provider cannot hold a lock or fail a signature.
- **Email cannot block signing.** Every message is written to the Outbox first, then handed
  to Resend if configured. Every signer also has a copyable link and a QR code.
- **Uploads and downloads fit serverless limits.** Uploads go up in 3 MB pieces; documents are
  streamed out of Postgres in slices with HTTP Range support, which is also what lets pdf.js
  show page one early.
- **Idempotent automation.** `external_id` makes API calls and CSV imports safe to retry.
  The daily reminder job decides what is due from stored state, so running it twice sends
  nothing twice.

### Security

- Tenant isolation: every tenant table carries `workspace_id` and every query filters on it;
  cross-tenant access is covered by tests at the service and API layers.
- Signing links carry 256 bits of entropy. Lookup is by SHA-256; the link itself is stored
  AES-256-GCM encrypted so staff can copy it again. Sign pages send `Referrer-Policy:
  no-referrer` and are not indexed.
- Passwords: scrypt with per-password salt. Sessions: random tokens stored hashed, httpOnly,
  SameSite=Lax cookies. API keys: shown once, stored hashed.
- A signer can only write fields assigned to their own role; the signing date is set by the
  server; everything is validated against the envelope's own snapshot.
- Rate limits are stored in Postgres so they hold across serverless instances.
- Webhooks are HMAC-SHA256 signed with a timestamp, and internal network targets are refused
  in production.
- Email previews render in a sandboxed iframe; all interpolated email content is escaped.
- Password reset links are single use, expire in an hour and sign out every other session.
  The Outbox copy of a reset email has the link removed, because teammates can read the
  Outbox. With no mail provider configured no link is minted; the owner issues one instead.
- Correcting a signer's email revokes the link already sent and issues a new one, and the
  change is written to the audit trail with before and after values.

## Project layout

```
src/
  lib/            Pure, shared by browser, server and tests
    detect.ts       field detection engine
    extract.ts      pdf.js document -> positioned text and form widgets
    geometry.ts     displayed page <-> PDF user space
    signature.ts    stroke normalisation and path building
    validate.ts     the single definition of "safe to send"
  server/
    db/             schema, engine selection, bundled migrations
    pdf/            stamping + certificate, typesetting, fonts
    services/       templates, files, signing, automation, accounts, demo
    audit.ts        hash-chained audit trail
    blobs.ts        document storage with range streaming
    email.ts        outbox + optional Resend delivery
    webhooks.ts     signed webhooks, rate limiting
  app/            Next.js routes: app pages, signing page, REST API, cron
  components/     UI: editor, signing experience, PDF viewer, signature pad
tests/            unit, detection on real PDFs, geometry, lifecycle, API
```

## Deploying

Onfile runs anywhere Node runs with a Postgres database. On Vercel:

1. Import the repository in Vercel (framework preset: Next.js).
2. Add a Postgres database: Vercel Storage, Neon. This sets `DATABASE_URL`.
3. Set environment variables (see `.env.example`):

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes (hosted) | Postgres connection string. Use the pooled URL on serverless. |
| `APP_SECRET` | Recommended | 32+ random characters. Encrypts signing links at rest. Derived from `DATABASE_URL` if absent. |
| `APP_URL` | Optional | Public origin used in links. Derived from the request if absent. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Optional | Real email delivery. Without them, messages stay in the Outbox. |
| `CRON_SECRET` | Recommended | Protects `/api/cron/tick`. Vercel Cron sends it automatically. |

4. Deploy. Migrations apply on the first request. `vercel.json` schedules the daily
   reminder and expiry job. `GET /api/health` reports database and email mode.

On any other host: `npm run build`, then `npm start` with the same variables.

## REST API

Authenticate with `Authorization: Bearer <api key>` (create keys under **Connect**).

| Method and path | Purpose |
| --- | --- |
| `POST /api/v1/files` | Open a file and send the agreement. Idempotent on `external_id`. |
| `GET /api/v1/files?status=` | List files. |
| `GET /api/v1/files/:id` | One file by Onfile id, reference or `external_id`. `cleared_to_start` is true once signed. |
| `GET /api/v1/files/:id/agreement` | The signed PDF. |

Webhook events: `agreement.sent`, `agreement.viewed`, `agreement.signed`,
`agreement.completed`, `agreement.declined`, `agreement.voided`, `agreement.expired`.
Each request carries `X-Onfile-Signature: t=<unix>,v1=<hmac_sha256(secret, t + "." + body)>`.

## Compliance references

Onfile implements the elements of a valid simple electronic signature under the U.S.
Electronic Signatures in Global and National Commerce Act (ESIGN, 15 U.S.C. 7001 et seq.) and
the Uniform Electronic Transactions Act (UETA): consent to do business electronically before
signing, a clear act showing intent to sign, the signature attached to the record, and a
copy of the signed record delivered to every party and retained. It does not provide
qualified or certificate-based signatures (eIDAS QES, PAdES); see SUBMISSION.md. This is an
engineering description, not legal advice.

## Stack

Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS 4, Drizzle ORM, Postgres / PGlite,
pdf-lib, pdf.js, mammoth, Zod, Vitest. Fonts: Instrument Sans (interface), DejaVu (bundled
for Unicode text in PDFs, see `assets/fonts/LICENSE-DejaVu.txt`).
