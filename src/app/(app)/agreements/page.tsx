import { Time } from "@/components/time";
import { FileSignature } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { TemplateActions } from "@/components/template-actions";
import { Badge, Card, PageHeader } from "@/components/ui";
import { UploadZone } from "@/components/upload-zone";
import { AUTO } from "@/lib/types";
import { requireCtx } from "@/server/auth";
import { listTemplates } from "@/server/services/templates";

export const metadata: Metadata = { title: "Agreements" };

export default async function AgreementsPage({ searchParams }: { searchParams: Promise<{ setup?: string }> }) {
  const { ctx } = await requireCtx();
  const templates = await listTemplates(ctx);
  const setup = (await searchParams).setup === "1";

  return (
    <>
      <PageHeader title="Agreements" description="The documents your clients sign. The default one is sent automatically on every new file." />
      {setup && (
        <p className="mb-5 rounded-xl border border-blue/20 bg-blue-50 p-4 text-sm text-ink-2">
          <strong className="font-semibold text-ink">Publish an agreement first.</strong> Files are sent the default agreement the moment they are opened, so one has to be live.
        </p>
      )}

      {templates.length > 0 && (
        <Card className="mb-8 divide-y divide-line-2 overflow-hidden">
          {templates.map((t) => {
            const signerFields = t.fields.filter((f) => f.assignee !== AUTO).length;
            return (
              <div key={t.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue">
                  <FileSignature className="size-5" />
                </span>
                <Link href={`/agreements/${t.id}`} className="min-w-0 flex-1 hover:underline">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[15px] font-semibold">{t.name}</span>
                    {t.status === "active" ? <Badge tone="green">Live, version {t.version}</Badge> : <Badge>Draft</Badge>}
                    {t.isDefault && <Badge tone="blue">Default</Badge>}
                  </span>
                  <span className="mt-0.5 block text-[13px] text-muted">
                    {t.pages.length} {t.pages.length === 1 ? "page" : "pages"}, {signerFields} {signerFields === 1 ? "field" : "fields"} for signers, edited <Time value={t.updatedAt} mode="ago" />
                  </span>
                </Link>
                <Link href={`/agreements/${t.id}`} className="text-sm font-semibold text-blue hover:underline">
                  {t.status === "active" ? "Edit" : "Finish setup"}
                </Link>
                <TemplateActions id={t.id} isDefault={t.isDefault} canDefault={t.status === "active"} />
              </div>
            );
          })}
        </Card>
      )}

      <h2 className="display mb-3 text-[22px]">{templates.length ? "Add another agreement" : "Upload your agreement"}</h2>
      <div className="max-w-2xl">
        <UploadZone />
        <p className="mt-4 text-[13px] leading-relaxed text-muted">
          Onfile reads the document and proposes where the signature, date and other fields go. PDFs are kept exactly as they are. Word and text files are converted to PDF, and you
          review the result before anything is sent.
        </p>
      </div>
    </>
  );
}
