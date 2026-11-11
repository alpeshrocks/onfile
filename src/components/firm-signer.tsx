"use client";

import { PenLine } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { setFirmSignerAction } from "@/app/actions";
import type { FirmSigner, SignatureValue } from "@/lib/types";
import { SignatureDialog, SignatureView } from "./signature";
import { Button, Dialog, Field, Input } from "./ui";

/**
 * The firm's standing signature: adopted once by someone authorized to sign, then applied
 * to every agreement automatically when it is sent.
 */
export function FirmSignerDialog({
  open,
  onClose,
  current,
  firmName,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  current: FirmSigner | null;
  firmName: string;
  onSaved: (signer: FirmSigner) => void;
}) {
  const [name, setName] = useState(current?.name ?? "");
  const [title, setTitle] = useState(current?.title ?? "");
  const [signature, setSignature] = useState<SignatureValue | null>(current?.signature ?? null);
  const [drawing, setDrawing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(current?.name ?? "");
      setTitle(current?.title ?? "");
      setSignature(current?.signature ?? null);
    }
  }, [open, current]);

  const save = async () => {
    if (!signature) return;
    setBusy(true);
    const signer = { name: name.trim(), title: title.trim(), signature };
    const r = await setFirmSignerAction(signer);
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success("Firm signature saved");
    onSaved(signer);
    onClose();
  };

  return (
    <>
      <Dialog
        open={open && !drawing}
        onClose={onClose}
        title="Firm signature"
        description={`Sign once for ${firmName}. Onfile applies this signature to every agreement as it is sent, so nobody has to countersign file by file. Each use is recorded in that agreement's audit trail.`}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!name.trim() || !signature} loading={busy}>
              Save firm signature
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Who signs for the firm">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" maxLength={120} autoComplete="name" />
          </Field>
          <Field label="Title" optional>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Managing Partner" maxLength={120} />
          </Field>
        </div>
        <div className="mt-4">
          <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">Signature</span>
          <button
            type="button"
            onClick={() => setDrawing(true)}
            disabled={!name.trim()}
            className="flex h-28 w-full items-center justify-center rounded-xl border border-dashed border-faint/70 bg-paper px-6 transition-colors hover:border-blue hover:bg-blue-50 disabled:opacity-60"
          >
            {signature ? (
              <span className="block h-20 w-full max-w-sm">
                <SignatureView value={signature} align="center" />
              </span>
            ) : (
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-blue">
                <PenLine className="size-4" /> {name.trim() ? "Draw or type the signature" : "Enter the signer's name first"}
              </span>
            )}
          </button>
          {signature && <p className="mt-1.5 text-[13px] text-muted">Select the signature to replace it.</p>}
        </div>
      </Dialog>
      <SignatureDialog
        open={drawing}
        onClose={() => setDrawing(false)}
        name={name.trim() || "Firm signer"}
        confirmLabel="Use this signature"
        onAdopt={(sig) => {
          setSignature(sig);
          setDrawing(false);
        }}
      />
    </>
  );
}
