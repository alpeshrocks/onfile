import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NewFileForm } from "@/components/new-file-form";
import { PageHeader } from "@/components/ui";
import { requiredInputs } from "@/lib/validate";
import { requireCtx } from "@/server/auth";
import { listTemplates } from "@/server/services/templates";

export const metadata: Metadata = { title: "Open a file" };

export default async function NewFilePage() {
  const { ctx } = await requireCtx();
  const templates = (await listTemplates(ctx)).filter((t) => t.status === "active");
  if (!templates.length) redirect("/agreements?setup=1");
  return (
    <>
      <Link href="/files" className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> Files
      </Link>
      <PageHeader title="Open a file" description="Enter who the client is. Onfile sends the agreement, follows up, and files the signed copy." />
      <NewFileForm templates={templates.map((t) => ({ id: t.id, name: t.name, isDefault: t.isDefault, roles: t.roles, inputs: requiredInputs(t) }))} />
    </>
  );
}
