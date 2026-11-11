"use client";

import { PenLine, Play, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { createInviteAction, createResetLinkAction, removeMemberAction, runAutomationAction, saveSettingsAction } from "@/app/actions";
import type { FirmSigner, WorkspaceSettings } from "@/lib/types";
import { FirmSignerDialog } from "./firm-signer";
import { SignatureView } from "./signature";
import { Button, Card, CopyButton, Field, Input } from "./ui";

export function SettingsForm({ name, brandColor, settings }: { name: string; brandColor: string; settings: WorkspaceSettings }) {
  const router = useRouter();
  const [form, setForm] = useState({
    name,
    brandColor,
    reminderDays: settings.reminderDays.join(", "),
    expiryDays: String(settings.expiryDays),
    notifyEmail: settings.notifyEmail,
    replyTo: settings.replyTo,
    timeZone: settings.timeZone,
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const r = await saveSettingsAction({
          name: form.name,
          brandColor: form.brandColor,
          reminderDays: form.reminderDays
            .split(/[,\s]+/)
            .map(Number)
            .filter((n) => Number.isFinite(n) && n > 0),
          expiryDays: Number(form.expiryDays) || 0,
          notifyEmail: form.notifyEmail.trim(),
          replyTo: form.replyTo.trim(),
          timeZone: form.timeZone.trim(),
        });
        setBusy(false);
        if (!r.ok) return void toast.error(r.error);
        toast.success("Settings saved");
        router.refresh();
      }}
      className="space-y-6"
    >
      <Card className="p-5 sm:p-6">
        <h2 className="text-[15px] font-semibold">Your firm</h2>
        <p className="mt-0.5 text-sm text-muted">Clients see this name and color on emails and on the signing page.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_180px]">
          <Field label="Firm name">
            <Input required value={form.name} onChange={set("name")} maxLength={120} />
          </Field>
          <Field label="Brand color">
            <div className="flex gap-2">
              <input type="color" value={form.brandColor} onChange={set("brandColor")} aria-label="Pick brand color" className="h-10 w-12 shrink-0 cursor-pointer rounded-md border border-line bg-surface p-1" />
              <Input value={form.brandColor} onChange={set("brandColor")} pattern="#[0-9a-fA-F]{6}" className="mono" aria-label="Brand color hex" />
            </div>
          </Field>
        </div>
      </Card>

      <Card className="p-5 sm:p-6">
        <h2 className="text-[15px] font-semibold">Follow-up</h2>
        <p className="mt-0.5 text-sm text-muted">Onfile reminds clients who have not signed, then closes the request if it goes stale.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Send reminders on these days after sending" hint="Comma separated. Leave empty for no reminders.">
            <Input value={form.reminderDays} onChange={set("reminderDays")} placeholder="2, 5, 9" inputMode="numeric" />
          </Field>
          <Field label="Expire unsigned requests after (days)" hint="0 means they never expire.">
            <Input type="number" min={0} max={365} value={form.expiryDays} onChange={set("expiryDays")} />
          </Field>
        </div>
      </Card>

      <Card className="p-5 sm:p-6">
        <h2 className="text-[15px] font-semibold">Notices and dates</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Tell this address when a file is signed" optional hint="Blank means whoever opened the file.">
            <Input type="email" value={form.notifyEmail} onChange={set("notifyEmail")} placeholder="intake@yourfirm.com" />
          </Field>
          <Field label="Replies from clients go to" optional>
            <Input type="email" value={form.replyTo} onChange={set("replyTo")} placeholder="you@yourfirm.com" />
          </Field>
          <Field label="Time zone for dates on agreements" hint="An IANA name such as America/Chicago.">
            <Input required value={form.timeZone} onChange={set("timeZone")} className="mono" />
          </Field>
        </div>
      </Card>

      <Button type="submit" loading={busy}>
        Save settings
      </Button>
    </form>
  );
}

export function FirmSignerCard({ firmName, current }: { firmName: string; current: FirmSigner | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signer, setSigner] = useState(current);
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-[15px] font-semibold">Firm signature</h2>
      <p className="mt-0.5 text-sm text-muted">Applied automatically wherever an agreement has a signature field for your firm.</p>
      {signer ? (
        <div className="mt-4 flex flex-wrap items-center gap-5">
          <div className="h-16 w-48 rounded-lg border border-line bg-paper p-2">
            <SignatureView value={signer.signature} align="center" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{signer.name}</p>
            <p className="text-sm text-muted">{signer.title || "Authorized signer"}</p>
          </div>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            Change
          </Button>
        </div>
      ) : (
        <Button className="mt-4" onClick={() => setOpen(true)}>
          <PenLine className="size-4" /> Set up firm signature
        </Button>
      )}
      <FirmSignerDialog
        open={open}
        onClose={() => setOpen(false)}
        current={signer}
        firmName={firmName}
        onSaved={(s) => {
          setSigner(s);
          router.refresh();
        }}
      />
    </Card>
  );
}

export function TeamCard({ members, currentUserId, isOwner }: { members: { id: string; name: string; email: string; role: string }[]; currentUserId: string; isOwner: boolean }) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);
  const [reset, setReset] = useState<{ name: string; url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const remove = async (m: { id: string; name: string }) => {
    if (!window.confirm(`Remove ${m.name}? They are signed out immediately and can no longer open this workspace. Files they opened stay.`)) return;
    setBusy(`remove:${m.id}`);
    const r = await removeMemberAction(m.id);
    setBusy(null);
    if (!r.ok) return void toast.error(r.error);
    toast.success(`${m.name} was removed`);
    router.refresh();
  };
  const resetLink = async (m: { id: string; name: string }) => {
    setBusy(`reset:${m.id}`);
    const r = await createResetLinkAction(m.id);
    setBusy(null);
    if (!r.ok) return void toast.error(r.error);
    setReset({ name: m.name, url: r.url });
  };

  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-[15px] font-semibold">Team</h2>
      <p className="mt-0.5 text-sm text-muted">Everyone on the team can open files and see every agreement. The owner manages who has access.</p>
      <ul className="mt-4 divide-y divide-line-2">
        {members.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5 text-sm">
            <span className="min-w-0">
              <span className="font-semibold">{m.name}</span> <span className="text-muted">{m.email}</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="mr-1 text-[13px] text-muted">{m.role === "owner" ? "Owner" : "Member"}{m.id === currentUserId ? " (you)" : ""}</span>
              {isOwner && m.id !== currentUserId && (
                <>
                  <Button size="sm" variant="ghost" loading={busy === `reset:${m.id}`} onClick={() => resetLink(m)}>
                    Reset link
                  </Button>
                  <Button size="sm" variant="ghost" loading={busy === `remove:${m.id}`} onClick={() => remove(m)}>
                    Remove
                  </Button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      {reset && (
        <div className="mt-4 rounded-lg bg-paper p-3">
          <p className="text-[13px] font-semibold text-ink-2">Password reset link for {reset.name}. Works once, for one hour. Pass it to them directly.</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="mono min-w-0 flex-1 truncate">{reset.url}</code>
            <CopyButton value={reset.url} />
          </div>
        </div>
      )}
      {url ? (
        <div className="mt-4 rounded-lg bg-paper p-3">
          <p className="text-[13px] font-semibold text-ink-2">Invitation link, valid for one person for 7 days</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="mono min-w-0 flex-1 truncate">{url}</code>
            <CopyButton value={url} />
          </div>
        </div>
      ) : (
        <Button
          variant="secondary"
          className="mt-4"
          loading={busy === "invite"}
          onClick={async () => {
            setBusy("invite");
            const r = await createInviteAction();
            setBusy(null);
            if (!r.ok) return void toast.error(r.error);
            setUrl(r.url);
          }}
        >
          <UserPlus className="size-4" /> Invite a teammate
        </Button>
      )}
    </Card>
  );
}

export function AutomationCard() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-[15px] font-semibold">Run follow-up now</h2>
      <p className="mt-0.5 text-sm text-muted">Reminders and expiry run on their own every day. Run them now to see the result straight away. Running twice never sends a reminder twice.</p>
      <Button
        variant="secondary"
        className="mt-4"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          const r = await runAutomationAction();
          setBusy(false);
          if (!r.ok) return void toast.error(r.error);
          toast.success(`Checked ${r.checked} open ${r.checked === 1 ? "agreement" : "agreements"}: ${r.reminded} reminded, ${r.expired} expired`);
          router.refresh();
        }}
      >
        <Play className="size-4" /> Run now
      </Button>
    </Card>
  );
}
