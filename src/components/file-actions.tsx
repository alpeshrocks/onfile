"use client";

import { BellRing, Ban, Pencil, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { remindAction, resendAction, updateSignerAction, voidAction } from "@/app/actions";
import { Button, Dialog, Field, Input, Textarea } from "./ui";

export function RemindButton({ envelopeId }: { envelopeId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        const r = await remindAction(envelopeId);
        setBusy(false);
        if (!r.ok) return void toast.error(r.error);
        toast.success(r.reminded === 1 ? "Reminder sent" : `Reminder sent to ${r.reminded} signers`);
        router.refresh();
      }}
    >
      <BellRing className="size-4" /> Send reminder
    </Button>
  );
}

export function VoidButton({ envelopeId }: { envelopeId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <Ban className="size-4" /> Void
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title="Void this agreement?"
        description="The signing links stop working immediately. The file stays blocked until a new agreement is sent and signed."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                const r = await voidAction(envelopeId, reason);
                setBusy(false);
                if (!r.ok) return void toast.error(r.error);
                setOpen(false);
                toast.success("Agreement voided");
                router.refresh();
              }}
            >
              Void agreement
            </Button>
          </>
        }
      >
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Reason, for the audit trail (optional)" aria-label="Reason" />
      </Dialog>
    </>
  );
}

export function ResendButton({ fileId, label = "Send a new agreement" }: { fileId: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      loading={busy}
      onClick={async () => {
        setBusy(true);
        const r = await resendAction(fileId);
        setBusy(false);
        if (!r.ok) return void toast.error(r.error);
        toast.success("A new agreement is on its way");
        router.refresh();
      }}
    >
      <RotateCcw className="size-4" /> {label}
    </Button>
  );
}

/** Fix a typo in a signer's name or email. The old link stops working and a new one goes out. */
export function EditSignerButton({ signerId, name, email, canRename }: { signerId: string; name: string; email: string; canRename: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name, email });
  const [busy, setBusy] = useState(false);
  const changed = form.name.trim() !== name || form.email.trim().toLowerCase() !== email;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setForm({ name, email });
          setOpen(true);
        }}
      >
        <Pencil className="size-3.5" /> Correct details
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title="Correct signer details"
        description="The link already sent stops working, and a new one goes to the address below. The change is recorded in the audit trail."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!changed || !form.name.trim() || !form.email.trim()}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                const r = await updateSignerAction(signerId, form);
                setBusy(false);
                if (!r.ok) return void toast.error(r.error);
                setOpen(false);
                toast.success("Details corrected. A new link was issued.");
                router.refresh();
              }}
            >
              Save and send new link
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Full name" hint={canRename ? undefined : "Someone has already signed, so the name can no longer change."}>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} maxLength={120} disabled={!canRename} autoComplete="off" />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} maxLength={200} autoComplete="off" />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
