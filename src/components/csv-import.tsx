"use client";

import { CircleAlert, CircleCheck, FileSpreadsheet, Upload } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { importFilesAction, type ImportRow } from "@/app/actions";
import { csvToRecords } from "@/lib/csv";
import type { TemplateOption } from "./new-file-form";
import { Badge, Button, Card, Select, Textarea } from "./ui";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const pick = (r: Record<string, string>, ...keys: string[]) => keys.map((k) => r[k]).find((v) => v?.trim())?.trim() ?? "";

/**
 * Bulk import for the backlog: paste or upload a spreadsheet export, see exactly what will
 * be sent, then open every file at once. Rows with a problem are skipped, not fatal.
 */
export function CsvImport({ templates }: { templates: TemplateOption[] }) {
  const [templateId, setTemplateId] = useState(templates.find((t) => t.isDefault)?.id ?? templates[0].id);
  const template = templates.find((t) => t.id === templateId)!;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ index: number; ok: boolean; reference?: string; error?: string; skipped?: boolean }[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const sample = useMemo(() => {
    const extra = template.roles.slice(1).flatMap((r) => [`${r.key}_name`, `${r.key}_email`]);
    const cols = ["client_name", "client_email", "reference", "title", ...extra, ...template.inputs.map((v) => v.key)];
    const row = ["Jordan Avery", "jordan.avery@example.com", "CLM-1001", "Kitchen water damage", ...extra.map((c) => (c.endsWith("email") ? "sam.avery@example.com" : "Sam Avery")), ...template.inputs.map(() => "Value")];
    return `${cols.join(",")}\n${row.join(",")}`;
  }, [template]);

  const parsed = useMemo(() => {
    const { headers, records } = csvToRecords(text);
    const rows = records.map((r) => {
      const signers = template.roles.map((role, i) => ({
        role: role.key,
        name: i === 0 ? pick(r, "client_name", "name", "client", "full_name") : pick(r, `${role.key}_name`),
        email: i === 0 ? pick(r, "client_email", "email", "e_mail") : pick(r, `${role.key}_email`),
      }));
      const variables: Record<string, string> = {};
      for (const v of template.inputs) variables[v.key] = pick(r, v.key);
      const problems: string[] = [];
      for (const s of signers) {
        const label = template.roles.find((x) => x.key === s.role)!.label;
        if (!s.name) problems.push(`${label} name missing`);
        if (!EMAIL.test(s.email)) problems.push(`${label} email ${s.email ? "invalid" : "missing"}`);
      }
      for (const v of template.inputs) if (v.required && !variables[v.key]) problems.push(`${v.label} missing`);
      const row: ImportRow = { reference: pick(r, "reference", "file", "file_number", "ref") || undefined, title: pick(r, "title", "description") || undefined, externalId: pick(r, "external_id", "id") || undefined, signers, variables };
      return { row, problems };
    });
    return { headers, rows };
  }, [text, template]);

  const valid = parsed.rows.filter((r) => r.problems.length === 0);

  const run = async () => {
    setBusy(true);
    const r = await importFilesAction(
      valid.map((v) => v.row),
      templateId,
    );
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    setResults(r.results);
  };

  if (results) {
    const ok = results.filter((r) => r.ok && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.filter((r) => !r.ok);
    return (
      <Card className="p-6 sm:p-8">
        <div className="flex items-start gap-3">
          <CircleCheck className="mt-1 size-6 shrink-0 text-green" />
          <div>
            <h2 className="display text-2xl">
              {ok} {ok === 1 ? "file" : "files"} opened and sent
            </h2>
            <p className="mt-1 text-sm text-muted">
              {skipped > 0 && `${skipped} already existed and were left alone. `}
              {failed.length > 0 ? `${failed.length} could not be opened.` : "Each client now has their agreement."}
            </p>
          </div>
        </div>
        {failed.length > 0 && (
          <ul className="mt-5 space-y-1.5 text-sm">
            {failed.map((f) => (
              <li key={f.index} className="flex items-start gap-2 text-red">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                {valid[f.index]?.row.signers[0]?.name}: {f.error}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-6 flex gap-2">
          <Link href="/files" className="inline-flex h-10 items-center rounded-md bg-blue px-4 text-sm font-semibold text-white hover:bg-blue-dark">
            View files
          </Link>
          <Button
            variant="secondary"
            onClick={() => {
              setResults(null);
              setText("");
            }}
          >
            Import another list
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-[15px] font-semibold">Your list</h2>
            <p className="mt-0.5 text-sm text-muted">Paste rows from a spreadsheet or upload a CSV. The first row must be column names.</p>
          </div>
          <div className="flex gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) setText(await f.text());
              }}
            />
            <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>
              <Upload className="size-3.5" /> Upload CSV
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setText(sample)}>
              Use example
            </Button>
          </div>
        </div>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={sample} spellCheck={false} aria-label="CSV data" className="mono mt-4 min-h-36 text-[13px]" />
        <p className="mt-2 text-[13px] text-muted">
          Columns: <span className="mono">client_name</span>, <span className="mono">client_email</span>, and optionally <span className="mono">reference</span>, <span className="mono">title</span>,{" "}
          <span className="mono">external_id</span>
          {template.inputs.map((v) => (
            <span key={v.key}>
              , <span className="mono">{v.key}</span>
            </span>
          ))}
          . Rows with an <span className="mono">external_id</span> you imported before are skipped, so re-running a list is safe.
        </p>
      </Card>

      {parsed.rows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-2 px-5 py-4">
            <p className="text-sm">
              <strong className="font-semibold">{valid.length}</strong> of {parsed.rows.length} rows ready
              {parsed.rows.length - valid.length > 0 && <span className="text-red">, {parsed.rows.length - valid.length} with problems will be skipped</span>}
            </p>
            <div className="flex items-center gap-2">
              {templates.length > 1 && (
                <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="h-9 w-56 text-sm" aria-label="Agreement to send">
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              )}
              <Button onClick={run} disabled={!valid.length} loading={busy}>
                <FileSpreadsheet className="size-4" /> Open {valid.length} {valid.length === 1 ? "file" : "files"} and send
              </Button>
            </div>
          </div>
          <div className="scroll-thin max-h-[420px] overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-paper text-xs text-muted">
                <tr>
                  <th className="px-5 py-2.5 font-semibold">Client</th>
                  <th className="px-3 py-2.5 font-semibold">Email</th>
                  <th className="px-3 py-2.5 font-semibold">Reference</th>
                  <th className="px-5 py-2.5 font-semibold">Check</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-2">
                {parsed.rows.slice(0, 200).map(({ row, problems }, i) => (
                  <tr key={i} className={problems.length ? "bg-red-50/50" : undefined}>
                    <td className="px-5 py-2.5 font-semibold">{row.signers[0]?.name || "(blank)"}</td>
                    <td className="px-3 py-2.5 text-ink-2">{row.signers[0]?.email}</td>
                    <td className="mono px-3 py-2.5 text-ink-2">{row.reference ?? "Automatic"}</td>
                    <td className="px-5 py-2.5">{problems.length ? <span className="text-red">{problems.join(", ")}</span> : <Badge tone="green">Ready</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
