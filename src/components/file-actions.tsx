"use client";

import { BellRing, Ban, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { remindAction, resendAction, voidAction } from "@/app/actions";
import { Button, Dialog, Textarea } from "./ui";

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
