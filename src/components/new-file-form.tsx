"use client";

import { Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { createFileAction } from "@/app/actions";
import type { Role, Variable } from "@/lib/types";
import { Button, Card, Field, Input, Select } from "./ui";

export interface TemplateOption {
  id: string;
  name: string;
  isDefault: boolean;
  roles: Role[];
  inputs: Variable[];
}

/**
 * Opening a file is the only step staff take. Everything the agreement needs is asked
 * here once; sending, reminders and filing the signed copy happen on their own.
 */
export function NewFileForm({ templates }: { templates: TemplateOption[] }) {
  const router = useRouter();
  const [templateId, setTemplateId] = useState(templates.find((t) => t.isDefault)?.id ?? templates[0].id);
  const template = templates.find((t) => t.id === templateId)!;
  const [people, setPeople] = useState<Record<string, { name: string; email: string }>>({});
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [reference, setReference] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const person = (key: string) => people[key] ?? { name: "", email: "" };
  const setPerson = (key: string, change: Partial<{ name: string; email: string }>) => setPeople((p) => ({ ...p, [key]: { ...person(key), ...change } }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await createFileAction({
      templateId,
      reference: reference.trim() || undefined,
      title: title.trim() || undefined,
      signers: template.roles.map((role) => ({ role: role.key, ...person(role.key) })),
      variables,
    });
    if (!r.ok) {
      setBusy(false);
      return void toast.error(r.error);
    }
    router.push(`/files/${r.fileId}?sent=1`);
  };

  return (
    <form onSubmit={submit} className="grid gap-6 xl:grid-cols-[1fr_300px]">
      <div className="space-y-6">
        {template.roles.map((role, i) => (
          <Card key={role.key} className="p-5 sm:p-6">
            <h2 className="text-[15px] font-semibold">{role.label}</h2>
            <p className="mt-0.5 text-sm text-muted">{i === 0 ? "Gets the agreement by email as soon as you open the file." : "Signs the same agreement from their own private link."}</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Full name">
                <Input required value={person(role.key).name} onChange={(e) => setPerson(role.key, { name: e.target.value })} maxLength={120} autoComplete="off" autoFocus={i === 0} />
              </Field>
              <Field label="Email">
                <Input required type="email" value={person(role.key).email} onChange={(e) => setPerson(role.key, { email: e.target.value })} maxLength={200} autoComplete="off" />
              </Field>
            </div>
          </Card>
        ))}

        <Card className="p-5 sm:p-6">
          <h2 className="text-[15px] font-semibold">File details</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Reference" optional hint="Leave blank and Onfile numbers it for you.">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} placeholder="For example: CLM-20418" />
            </Field>
            <Field label="Description" optional>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="For example: Kitchen water damage" />
            </Field>
          </div>
          {template.inputs.length > 0 && (
            <div className="mt-5 border-t border-line-2 pt-5">
              <h3 className="text-[13px] font-semibold text-ink-2">Printed on this agreement</h3>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                {template.inputs.map((v) => (
                  <Field key={v.key} label={v.label} optional={!v.required}>
                    <Input required={v.required} value={variables[v.key] ?? ""} onChange={(e) => setVariables((prev) => ({ ...prev, [v.key]: e.target.value }))} maxLength={500} />
                  </Field>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      <aside className="space-y-4 xl:sticky xl:top-8 xl:self-start">
        <Card className="p-5">
          <Field label="Agreement to send">
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={templates.length === 1}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isDefault ? " (default)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <ul className="mt-4 space-y-2 text-[13px] text-ink-2">
            <li>Sent to the client the moment you open the file.</li>
            <li>Reminders go out on your schedule until it is signed.</li>
            <li>The file stays blocked until the signed copy is in.</li>
          </ul>
          <Button type="submit" size="lg" className="mt-5 w-full" loading={busy}>
            <Send className="size-4" /> Open file and send
          </Button>
        </Card>
      </aside>
    </form>
  );
}
