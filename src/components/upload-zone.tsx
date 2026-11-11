"use client";

import clsx from "clsx";
import { FileUp, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { sampleAgreementAction } from "@/app/actions";
import { formatBytes } from "@/lib/format";
import { rasterizeToPdf } from "./pdf";
import { Button, Spinner } from "./ui";

const CHUNK = 3 * 1024 * 1024;
const MAX = 25 * 1024 * 1024;

type State =
  | { kind: "idle" }
  | { kind: "working"; label: string; progress: number }
  | { kind: "repair"; file: File; message: string };

async function upload(data: Blob, name: string, onProgress: (p: number) => void): Promise<{ id: string; converted: boolean }> {
  const total = Math.max(1, Math.ceil(data.size / CHUNK));
  const uploadId = crypto.randomUUID().replace(/-/g, "");
  let last: unknown = null;
  for (let index = 0; index < total; index++) {
    const part = data.slice(index * CHUNK, (index + 1) * CHUNK);
    const res = await fetch(`/api/uploads?uploadId=${uploadId}&index=${index}&total=${total}&name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: part,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body?.error?.message ?? "Upload failed. Try again."), { code: body?.error?.code as string | undefined });
    last = body;
    onProgress((index + 1) / total);
  }
  return last as { id: string; converted: boolean };
}

/**
 * Bring an agreement in whatever form it exists. Large files go up in pieces; a PDF the
 * server cannot stamp (password protected, malformed) can be rebuilt in the browser.
 */
export function UploadZone({ compact, sample = true }: { compact?: boolean; sample?: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [over, setOver] = useState(false);

  const send = async (data: Blob, name: string) => {
    setState({ kind: "working", label: `Uploading ${name}`, progress: 0 });
    const result = await upload(data, name, (p) => setState({ kind: "working", label: p < 1 ? `Uploading ${name}` : "Preparing your agreement", progress: p }));
    if (result.converted) toast.success("Converted to PDF. Check that it looks right.");
    router.push(`/agreements/${result.id}`);
  };

  const handle = async (file: File) => {
    if (file.size > MAX) return void toast.error(`That file is ${formatBytes(file.size)}. Files can be up to 25 MB.`);
    try {
      await send(file, file.name);
    } catch (err) {
      const e = err as Error & { code?: string };
      if ((e.code === "pdf_encrypted" || e.code === "pdf_unreadable") && /pdf$/i.test(file.name)) {
        setState({ kind: "repair", file, message: e.message });
      } else {
        setState({ kind: "idle" });
        toast.error(e.message);
      }
    }
  };

  const repair = async (file: File) => {
    try {
      setState({ kind: "working", label: "Making a compatible copy", progress: 0 });
      const bytes = await rasterizeToPdf(file, (done, total) => setState({ kind: "working", label: `Making a compatible copy, page ${done} of ${total}`, progress: done / total }));
      await send(new Blob([bytes as BlobPart], { type: "application/pdf" }), file.name);
    } catch {
      setState({ kind: "idle" });
      toast.error("This PDF could not be opened at all. Print it to a new PDF and upload that.");
    }
  };

  const useSample = async () => {
    setState({ kind: "working", label: "Preparing the sample agreement", progress: 1 });
    const r = await sampleAgreementAction();
    if (!r.ok) {
      setState({ kind: "idle" });
      return void toast.error(r.error);
    }
    router.push(`/agreements/${r.id}`);
  };

  if (state.kind === "repair") {
    return (
      <div className="rounded-xl border border-amber/30 bg-amber-50 p-5">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber" />
          <div>
            <p className="font-semibold">{state.message}</p>
            <p className="mt-1 text-sm text-ink-2">
              Onfile can make a compatible copy right here in your browser. The pages will look identical. Because they become images, fields will not be detected automatically, but you can
              add a signature page in one click.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => repair(state.file)}>Make a compatible copy</Button>
              <Button variant="ghost" onClick={() => setState({ kind: "idle" })}>
                Choose another file
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const working = state.kind === "working";
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload an agreement"
        onClick={() => !working && input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !working && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const file = e.dataTransfer.files[0];
          if (file && !working) void handle(file);
        }}
        className={clsx(
          "relative flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 text-center transition-colors",
          compact ? "py-8" : "py-12",
          over ? "border-blue bg-blue-50" : "border-line bg-surface hover:border-blue/60 hover:bg-blue-50/40",
          working && "cursor-progress",
        )}
      >
        <input
          ref={input}
          type="file"
          className="sr-only"
          accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handle(file);
          }}
        />
        {working ? (
          <>
            <Spinner className="size-6 text-blue" />
            <p className="mt-3 text-sm font-semibold">{state.label}</p>
            <div className="mt-3 h-1.5 w-48 overflow-hidden rounded-full bg-line-2">
              <div className="h-full rounded-full bg-blue transition-[width] duration-300" style={{ width: `${Math.max(6, state.progress * 100)}%` }} />
            </div>
          </>
        ) : (
          <>
            <span className="grid size-12 place-items-center rounded-full bg-blue-50 text-blue">
              <FileUp className="size-5.5" />
            </span>
            <p className="mt-3 text-[15px] font-semibold">Drop your agreement here, or choose a file</p>
            <p className="mt-1 text-sm text-muted">PDF, Word (.docx), a photo or scan, or plain text. Up to 25 MB.</p>
          </>
        )}
      </div>
      {sample && !working && (
        <p className="mt-3 text-sm text-muted">
          No agreement to hand?{" "}
          <button type="button" onClick={useSample} className="font-semibold text-blue hover:underline">
            Try it with a sample agreement
          </button>
        </p>
      )}
    </div>
  );
}
