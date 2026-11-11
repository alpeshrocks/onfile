"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { archiveTemplateAction, setDefaultTemplateAction } from "@/app/actions";
import { Button } from "./ui";

export function TemplateActions({ id, isDefault, canDefault }: { id: string; isDefault: boolean; canDefault: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (kind: "default" | "archive") => {
    if (kind === "archive" && !window.confirm("Archive this agreement? Files already sent keep their copy. New files will no longer use it.")) return;
    setBusy(kind);
    const r = kind === "default" ? await setDefaultTemplateAction(id) : await archiveTemplateAction(id);
    setBusy(null);
    if (!r.ok) return void toast.error(r.error);
    toast.success(kind === "default" ? "This is now the default agreement" : "Agreement archived");
    router.refresh();
  };
  return (
    <div className="flex gap-1">
      {canDefault && !isDefault && (
        <Button size="sm" variant="ghost" loading={busy === "default"} onClick={() => act("default")}>
          Make default
        </Button>
      )}
      <Button size="sm" variant="ghost" loading={busy === "archive"} onClick={() => act("archive")}>
        Archive
      </Button>
    </div>
  );
}
