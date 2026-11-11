"use client";

import { Time } from "./time";
import { KeyRound, Trash2, Webhook } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { createApiKeyAction, createWebhookAction, deleteWebhookAction, revokeApiKeyAction } from "@/app/actions";
import { Badge, Button, Card, CopyButton, Dialog, Input } from "./ui";

export function ApiKeys({ keys }: { keys: { id: string; name: string; prefix: string; lastUsedAt: string | null; createdAt: string }[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  return (
    <Card className="overflow-hidden">
      <form
        className="flex flex-wrap items-center gap-2 border-b border-line-2 p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const r = await createApiKeyAction(name || "API key");
          setBusy(false);
          if (!r.ok) return void toast.error(r.error);
          setSecret(r.secret);
          setName("");
          router.refresh();
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this key, for example: Case system" maxLength={60} className="min-w-52 flex-1" aria-label="Key name" />
        <Button type="submit" loading={busy}>
          <KeyRound className="size-4" /> Create key
        </Button>
      </form>
      {keys.length === 0 ? (
        <p className="p-5 text-sm text-muted">No keys yet. Create one to let another system open files.</p>
      ) : (
        <ul className="divide-y divide-line-2">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center gap-4 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{k.name}</p>
                <p className="text-[13px] text-muted">
                  <span className="mono">{k.prefix}...</span> created <Time value={k.createdAt} mode="date" />,{" "}
                  {k.lastUsedAt ? (
                    <>
                      last used <Time value={k.lastUsedAt} mode="ago" />
                    </>
                  ) : (
                    "never used"
                  )}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (!window.confirm(`Revoke "${k.name}"? Anything using it stops working immediately.`)) return;
                  const r = await revokeApiKeyAction(k.id);
                  if (!r.ok) return void toast.error(r.error);
                  router.refresh();
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={Boolean(secret)}
        onClose={() => setSecret(null)}
        size="md"
        title="Copy your API key now"
        description="This is the only time the full key is shown. Onfile stores only a hash of it."
        footer={<Button onClick={() => setSecret(null)}>I have saved it</Button>}
      >
        <div className="flex items-center gap-2 rounded-lg bg-paper p-3">
          <code className="mono min-w-0 flex-1 break-all">{secret}</code>
          {secret && <CopyButton value={secret} />}
        </div>
      </Dialog>
    </Card>
  );
}

export function Webhooks({
  hooks,
  deliveries,
}: {
  hooks: { id: string; url: string; secret: string; createdAt: string }[];
  deliveries: { id: string; eventType: string; ok: boolean; statusCode: number | null; error: string | null; durationMs: number | null; createdAt: string }[];
}) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <form
          className="flex flex-wrap items-center gap-2 border-b border-line-2 p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const r = await createWebhookAction(url);
            setBusy(false);
            if (!r.ok) return void toast.error(r.error);
            setUrl("");
            toast.success("Endpoint added");
            router.refresh();
          }}
        >
          <Input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-system.example.com/onfile" className="min-w-52 flex-1" aria-label="Endpoint URL" />
          <Button type="submit" loading={busy}>
            <Webhook className="size-4" /> Add endpoint
          </Button>
        </form>
        {hooks.length === 0 ? (
          <p className="p-5 text-sm text-muted">No endpoints yet. Add one and Onfile will tell it the moment a file is signed.</p>
        ) : (
          <ul className="divide-y divide-line-2">
            {hooks.map((h) => (
              <li key={h.id} className="px-5 py-3.5">
                <div className="flex items-center gap-3">
                  <p className="mono min-w-0 flex-1 truncate font-semibold">{h.url}</p>
                  <button
                    type="button"
                    aria-label="Remove endpoint"
                    onClick={async () => {
                      if (!window.confirm("Remove this endpoint?")) return;
                      await deleteWebhookAction(h.id);
                      router.refresh();
                    }}
                    className="grid size-8 place-items-center rounded-md text-muted hover:bg-red-50 hover:text-red"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
                <div className="mt-1.5 flex items-center gap-2 text-[13px] text-muted">
                  Signing secret <code className="mono rounded bg-paper px-1.5 py-0.5">{h.secret.slice(0, 12)}...</code>
                  <CopyButton value={h.secret} label="Copy secret" variant="ghost" />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {deliveries.length > 0 && (
        <Card className="overflow-hidden">
          <p className="border-b border-line-2 px-5 py-3 text-[13px] font-semibold text-ink-2">Recent deliveries</p>
          <ul className="divide-y divide-line-2 text-sm">
            {deliveries.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-5 py-2.5">
                {d.ok ? <Badge tone="green">{d.statusCode}</Badge> : <Badge tone="red">{d.statusCode ?? "Failed"}</Badge>}
                <span className="mono flex-1 truncate">{d.eventType}</span>
                {d.error && <span className="truncate text-[13px] text-red max-sm:hidden">{d.error}</span>}
                <span className="shrink-0 text-xs text-faint">
                  {d.durationMs} ms, <Time value={d.createdAt} mode="ago" />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
