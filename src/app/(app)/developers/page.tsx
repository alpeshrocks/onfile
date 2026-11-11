import type { Metadata } from "next";
import { ApiKeys, Webhooks } from "@/components/connect-client";
import { CopyButton, PageHeader } from "@/components/ui";
import { requireCtx } from "@/server/auth";
import { listApiKeys, listWebhooks } from "@/server/services/accounts";
import { WEBHOOK_EVENTS } from "@/server/webhooks";

export const metadata: Metadata = { title: "Connect" };

function Code({ children }: { children: string }) {
  return (
    <div className="relative mt-3">
      <pre className="scroll-thin overflow-x-auto rounded-xl bg-ink p-4 pr-24 text-[12.5px] leading-relaxed text-white/90">
        <code className="font-mono">{children}</code>
      </pre>
      <div className="absolute top-2.5 right-2.5">
        <CopyButton value={children} />
      </div>
    </div>
  );
}

export default async function ConnectPage() {
  const { ctx } = await requireCtx();
  const [keys, hooks] = await Promise.all([listApiKeys(ctx), listWebhooks(ctx)]);
  const base = ctx.baseUrl;

  return (
    <>
      <PageHeader
        title="Connect your systems"
        description="Let the software you already run open files. When a file is created there, the agreement goes out here, and your system hears back the moment it is signed."
      />

      <div className="grid gap-10 xl:grid-cols-[1fr_1fr]">
        <div className="space-y-10">
          <section>
            <h2 className="display text-[22px]">API keys</h2>
            <p className="mt-1 mb-3 text-sm text-muted">A key lets another system act for this workspace. Treat it like a password.</p>
            <ApiKeys keys={keys.map((k) => ({ ...k, lastUsedAt: k.lastUsedAt?.toISOString() ?? null, createdAt: k.createdAt.toISOString() }))} />
          </section>
          <section>
            <h2 className="display text-[22px]">Webhooks</h2>
            <p className="mt-1 mb-3 text-sm text-muted">Onfile posts to your endpoint when something happens on a file.</p>
            <Webhooks
              hooks={hooks.hooks.map((h) => ({ id: h.id, url: h.url, secret: h.secret, createdAt: h.createdAt.toISOString() }))}
              deliveries={hooks.deliveries.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() }))}
            />
          </section>
        </div>

        <section className="min-w-0">
          <h2 className="display text-[22px]">How to use it</h2>

          <h3 className="mt-5 text-[15px] font-semibold">Open a file and send the agreement</h3>
          <p className="mt-1 text-sm text-ink-2">
            One request. Send your own <code className="mono">external_id</code> and it is safe to retry: a repeat returns the same file instead of sending twice.
          </p>
          <Code>{`curl -X POST ${base}/api/v1/files \\
  -H "Authorization: Bearer $ONFILE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "external_id": "case-20418",
    "title": "Kitchen water damage",
    "client": { "name": "Jordan Avery", "email": "jordan.avery@example.com" },
    "variables": {}
  }'`}</Code>

          <h3 className="mt-7 text-[15px] font-semibold">Check whether work can start</h3>
          <p className="mt-1 text-sm text-ink-2">
            Look a file up by its Onfile id, your reference, or your <code className="mono">external_id</code>. <code className="mono">cleared_to_start</code> is true once everyone has signed.
          </p>
          <Code>{`curl ${base}/api/v1/files/case-20418 \\
  -H "Authorization: Bearer $ONFILE_KEY"

# Download the signed PDF
curl -L ${base}/api/v1/files/case-20418/agreement \\
  -H "Authorization: Bearer $ONFILE_KEY" -o signed.pdf`}</Code>

          <h3 className="mt-7 text-[15px] font-semibold">Webhook events</h3>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {WEBHOOK_EVENTS.map((e) => (
              <li key={e} className="mono rounded-md bg-line-2 px-2 py-1 text-ink-2">
                {e}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-ink-2">
            Each request carries <code className="mono">X-Onfile-Signature: t=timestamp,v1=signature</code>, where the signature is HMAC-SHA256 of <code className="mono">timestamp.body</code> using
            the endpoint&apos;s signing secret. Verify it before trusting the payload.
          </p>
          <Code>{`import crypto from "node:crypto";

function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const expected = crypto.createHmac("sha256", secret).update(t + "." + rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}`}</Code>
          <p className="mt-4 text-[13px] text-muted">No developer to hand? Zapier, Make and n8n can all send the request above, and a spreadsheet works through Files, Import a list.</p>
        </section>
      </div>
    </>
  );
}
