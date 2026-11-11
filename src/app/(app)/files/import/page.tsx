import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CsvImport } from "@/components/csv-import";
import { PageHeader } from "@/components/ui";
import { requiredInputs } from "@/lib/validate";
import { requireCtx } from "@/server/auth";
import { listTemplates } from "@/server/services/templates";

export const metadata: Metadata = { title: "Import files" };

export default async function ImportPage() {
  const { ctx } = await requireCtx();
  const templates = (await listTemplates(ctx)).filter((t) => t.status === "active");
  if (!templates.length) redirect("/agreements?setup=1");
  return (
    <>
      <Link href="/files" className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> Files
      </Link>
      <PageHeader title="Import a list of files" description="Put every open file through signing at once. Each client is sent the agreement as their row is imported." />
      <CsvImport templates={templates.map((t) => ({ id: t.id, name: t.name, isDefault: t.isDefault, roles: t.roles, inputs: requiredInputs(t) }))} />
    </>
  );
}
