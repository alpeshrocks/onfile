import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SigningExperience } from "@/components/signing-experience";
import { requireCtx } from "@/server/auth";
import { getPreviewView } from "@/server/services/signing";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Client preview", robots: { index: false } };

/** Walk through the client's signing experience for an agreement, with sample data. */
export default async function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireCtx();
  const { id } = await params;
  const view = await getPreviewView(ctx, id);
  if (!view) notFound();
  return <SigningExperience token="" view={view} preview={{ documentUrl: `/api/documents/template/${id}`, backHref: `/agreements/${id}` }} />;
}
