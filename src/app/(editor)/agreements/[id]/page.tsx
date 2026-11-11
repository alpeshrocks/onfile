import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TemplateEditor } from "@/components/template-editor";
import { requireCtx } from "@/server/auth";
import { getDb } from "@/server/db";
import { getTemplate } from "@/server/services/templates";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Edit agreement" };

export default async function AgreementEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx, workspace } = await requireCtx();
  const template = await getTemplate(await getDb(), ctx.workspaceId, (await params).id);
  if (!template || template.status === "archived") notFound();
  return (
    <TemplateEditor
      firmName={workspace.name}
      firmSigner={workspace.firmSigner ?? null}
      template={{
        id: template.id,
        name: template.name,
        status: template.status,
        version: template.version,
        isDefault: template.isDefault,
        sha256: template.sha256,
        pages: template.pages,
        fields: template.fields,
        roles: template.roles,
        variables: template.variables,
        detected: template.detected,
        emailSubject: template.emailSubject,
        emailMessage: template.emailMessage,
      }}
    />
  );
}
