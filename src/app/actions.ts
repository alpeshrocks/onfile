"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import type { ActionResult } from "@/lib/types";
import { clearSessionCookie, requestMeta, requireCtx, sessionToken, setSessionCookie } from "@/server/auth";
import { AppError } from "@/server/context";
import { getDb } from "@/server/db";
import * as accounts from "@/server/services/accounts";
import { runAutomation } from "@/server/services/automation";
import { createDemoWorkspace, sampleAgreementWithBlanks } from "@/server/services/demo";
import * as fileService from "@/server/services/files";
import { verifyDocument } from "@/server/services/signing";
import * as templateService from "@/server/services/templates";
import { rateLimit } from "@/server/webhooks";

/** Turn thrown errors into a result the UI can show. Unknown errors are logged, not leaked. */
async function run<T extends object>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    if (err instanceof AppError) return { ok: false, error: err.message };
    if (err instanceof ZodError) return { ok: false, error: err.issues[0]?.message ?? "Check the form and try again." };
    console.error("[onfile] action failed:", err);
    return { ok: false, error: "Something went wrong on our side. Try again." };
  }
}

async function limit(scope: string, max: number, seconds: number) {
  const meta = await requestMeta();
  const ok = await rateLimit(await getDb(), `${scope}:${meta.ip ?? "unknown"}`, max, seconds);
  if (!ok) throw new AppError("Too many attempts. Wait a minute and try again.", "rate_limited", 429);
  return meta;
}

// ---- Accounts ---------------------------------------------------------------

export async function signupAction(input: unknown) {
  return run(async () => {
    await limit("signup", 8, 600);
    const account = await accounts.signup(input);
    await setSessionCookie(account.token);
    return {};
  });
}

export async function loginAction(input: unknown) {
  return run(async () => {
    await limit("login", 12, 300);
    const session = await accounts.login(input);
    await setSessionCookie(session.token);
    return {};
  });
}

export async function demoAction(timeZone?: string) {
  return run(async () => {
    const meta = await limit("demo", 6, 600);
    const account = await createDemoWorkspace(meta.baseUrl, timeZone);
    await setSessionCookie(account.token);
    return {};
  });
}

export async function joinAction(token: string, input: unknown) {
  return run(async () => {
    await limit("join", 8, 600);
    const session = await accounts.acceptInvite(token, input);
    await setSessionCookie(session.token);
    return {};
  });
}

export async function logoutAction() {
  await accounts.endSession(await sessionToken());
  await clearSessionCookie();
}

// ---- Agreements (templates) -------------------------------------------------

export async function saveTemplateAction(id: string, patch: unknown, publish = false) {
  return run(async () => {
    const { ctx } = await requireCtx();
    const template = await templateService.saveTemplate(ctx, id, patch, { publish });
    revalidatePath("/agreements");
    revalidatePath("/dashboard");
    return { version: template.version, status: template.status, isDefault: template.isDefault };
  });
}

export async function addSignaturePageAction(id: string, includeFirm: boolean) {
  return run(async () => {
    const { ctx } = await requireCtx();
    const t = await templateService.addSignaturePage(ctx, id, { includeFirm });
    return { fields: t.fields, pages: t.pages, sha256: t.sha256 };
  });
}

/** A sample agreement that goes through the real upload pipeline, for trying the product. */
export async function sampleAgreementAction() {
  return run(async () => {
    const { ctx, workspace } = await requireCtx();
    const text = sampleAgreementWithBlanks(workspace.name);
    const { id } = await templateService.ingestDocument(ctx, { bytes: new TextEncoder().encode(text), filename: "Client Services Agreement.txt" });
    return { id };
  });
}

export async function setDefaultTemplateAction(id: string) {
  return run(async () => {
    const { ctx } = await requireCtx();
    await templateService.setDefaultTemplate(ctx, id);
    revalidatePath("/agreements");
    return {};
  });
}

export async function archiveTemplateAction(id: string) {
  return run(async () => {
    const { ctx } = await requireCtx();
    await templateService.archiveTemplate(ctx, id);
    revalidatePath("/agreements");
    return {};
  });
}

// ---- Files ------------------------------------------------------------------

export async function createFileAction(input: fileService.CreateFileInput) {
  return run(async () => {
    const { ctx } = await requireCtx();
    const created = await fileService.createFile(ctx, { ...input, source: "manual" });
    revalidatePath("/files");
    revalidatePath("/dashboard");
    return { fileId: created.file.id };
  });
}

export interface ImportRow {
  reference?: string;
  title?: string;
  externalId?: string;
  signers: { role: string; name: string; email: string }[];
  variables: Record<string, string>;
}

/** Bulk import: each row is its own transaction, so one bad row never blocks the rest. */
export async function importFilesAction(rows: ImportRow[], templateId?: string) {
  return run(async () => {
    const { ctx } = await requireCtx();
    if (rows.length > 200) throw new AppError("Import up to 200 files at a time.");
    const results: { index: number; ok: boolean; reference?: string; error?: string; skipped?: boolean }[] = [];
    for (let i = 0; i < rows.length; i++) {
      try {
        const created = await fileService.createFile(ctx, { ...rows[i], templateId, source: "csv" });
        results.push({ index: i, ok: true, reference: created.file.reference, skipped: created.existing });
      } catch (err) {
        const message = err instanceof AppError ? err.message : err instanceof ZodError ? (err.issues[0]?.message ?? "Invalid row") : "Could not create this file";
        results.push({ index: i, ok: false, error: message });
      }
    }
    revalidatePath("/files");
    revalidatePath("/dashboard");
    return { results };
  });
}

export async function remindAction(envelopeId: string) {
  return run(async () => {
    const { ctx } = await requireCtx();
    const r = await fileService.remindAgreement(ctx, envelopeId);
    revalidatePath("/files");
    return r;
  });
}

export async function voidAction(envelopeId: string, reason: string) {
  return run(async () => {
    const { ctx } = await requireCtx();
    await fileService.voidAgreement(ctx, envelopeId, reason);
    revalidatePath("/files");
    revalidatePath("/dashboard");
    return {};
  });
}

export async function resendAction(fileId: string) {
  return run(async () => {
    const { ctx } = await requireCtx();
    await fileService.resendAgreement(ctx, fileId);
    revalidatePath("/files");
    revalidatePath("/dashboard");
    return {};
  });
}

// ---- Settings ---------------------------------------------------------------

export async function saveSettingsAction(input: unknown) {
  return run(async () => {
    const { ctx } = await requireCtx();
    await accounts.updateSettings(ctx, input);
    revalidatePath("/", "layout");
    return {};
  });
}

export async function setFirmSignerAction(input: unknown) {
  return run(async () => {
    const { ctx } = await requireCtx();
    await accounts.setFirmSigner(ctx, input);
    revalidatePath("/settings");
    return {};
  });
}

export async function createInviteAction() {
  return run(async () => {
    const { ctx } = await requireCtx();
    return { url: await accounts.createInvite(ctx) };
  });
}

export async function createApiKeyAction(name: string) {
  return run(async () => {
    const { ctx } = await requireCtx();
    const key = await accounts.createApiKey(ctx, name);
    revalidatePath("/developers");
    return key;
  });
}

export async function revokeApiKeyAction(id: string) {
  return run(async () => {
    const { ctx } = await requireCtx();
    await accounts.revokeApiKey(ctx, id);
    revalidatePath("/developers");
    return {};
  });
}

export async function createWebhookAction(url: string) {
  return run(async () => {
    const { ctx } = await requireCtx();
    const hook = await accounts.createWebhook(ctx, url);
    revalidatePath("/developers");
    return hook;
  });
}

export async function deleteWebhookAction(id: string) {
  return run(async () => {
    const { ctx } = await requireCtx();
    await accounts.deleteWebhook(ctx, id);
    revalidatePath("/developers");
    return {};
  });
}

export async function runAutomationAction() {
  return run(async () => {
    const { ctx } = await requireCtx();
    const r = await runAutomation(ctx.baseUrl, ctx.workspaceId);
    revalidatePath("/files");
    return { reminded: r.reminded, expired: r.expired, checked: r.checked };
  });
}

// ---- Public -----------------------------------------------------------------

export async function verifyAction(query: { docId?: string; sha256?: string }) {
  return run(async () => {
    await limit("verify", 30, 60);
    const r = await verifyDocument(query);
    if (!r.found) return { result: r };
    // Public page: reveal that a record exists and who signed, but mask contact details.
    return {
      result: {
        ...r,
        sentAt: r.sentAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
        signers: r.signers.map((s) => ({
          name: s.name,
          role: s.role,
          email: s.email.replace(/^(.).*(@.*)$/, "$1*****$2"),
          signedAt: s.signedAt?.toISOString() ?? null,
        })),
      },
    };
  });
}
