import { newId } from "./crypto";
import type { DbOrTx } from "./db";
import { emails } from "./db/schema";

/**
 * Email with a safety net.
 *
 * Every message is written to the Outbox first. If RESEND_API_KEY is configured it is then
 * handed to Resend; if not, it stays "captured" and staff can open it (and copy the signing
 * link) in the app. Signing therefore never depends on deliverability, which matters on day
 * one before a sending domain is verified.
 */

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface EmailContent {
  firmName: string;
  brandColor: string;
  heading: string;
  paragraphs: string[];
  /** Optional quoted note from the firm, shown as a block. */
  note?: string;
  cta?: { label: string; url: string };
  details?: [string, string][];
  footnote?: string;
}

export function renderEmail(c: EmailContent) {
  const color = /^#[0-9a-fA-F]{6}$/.test(c.brandColor) ? c.brandColor : "#1B3FD8";
  const details = c.details?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;border-top:1px solid #E3E7EE;width:100%">${c.details
        .map(
          ([k, v]) =>
            `<tr><td style="padding:10px 0;border-bottom:1px solid #E3E7EE;color:#5B6676;font-size:13px;width:38%">${esc(k)}</td><td style="padding:10px 0;border-bottom:1px solid #E3E7EE;color:#0E1A2B;font-size:13px;font-weight:600">${esc(v)}</td></tr>`,
        )
        .join("")}</table>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#F3F5F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0E1A2B">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F8;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:12px;border:1px solid #E3E7EE">
<tr><td style="padding:28px 32px 0"><div style="font-size:14px;font-weight:700;color:${color}">${esc(c.firmName)}</div></td></tr>
<tr><td style="padding:14px 32px 32px">
<h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;font-weight:700;color:#0E1A2B">${esc(c.heading)}</h1>
${c.paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#33404F">${esc(p)}</p>`).join("")}
${c.note ? `<div style="margin:16px 0;padding:12px 16px;border-left:3px solid ${color};background:#F6F8FB;font-size:14px;line-height:1.6;color:#33404F;white-space:pre-wrap">${esc(c.note)}</div>` : ""}
${details}
${c.cta ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px"><tr><td style="border-radius:8px;background:${color}"><a href="${esc(c.cta.url)}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${esc(c.cta.label)}</a></td></tr></table>
<p style="margin:14px 0 0;font-size:12px;line-height:1.6;color:#7A8594">If the button does not work, paste this link into your browser:<br><a href="${esc(c.cta.url)}" style="color:${color};word-break:break-all">${esc(c.cta.url)}</a></p>` : ""}
${c.footnote ? `<p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#7A8594">${esc(c.footnote)}</p>` : ""}
</td></tr></table>
<p style="margin:16px 0 0;font-size:11px;color:#8A94A3">Sent by ${esc(c.firmName)} using Onfile, electronic agreement signing.</p>
</td></tr></table></body></html>`;
}

export interface OutgoingEmail {
  workspaceId: string;
  envelopeId?: string | null;
  fileId?: string | null;
  kind: string;
  to: string;
  toName?: string;
  subject: string;
  replyTo?: string;
  fromName: string;
  content: EmailContent;
}

export async function sendEmail(db: DbOrTx, msg: OutgoingEmail) {
  const id = newId("eml");
  const html = renderEmail(msg.content);
  let status: "delivered" | "captured" | "failed" = "captured";
  let error: string | null = null;
  let providerId: string | null = null;

  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    const fromAddress = (process.env.EMAIL_FROM ?? "Onfile <onboarding@resend.dev>").replace(/^.*<([^>]+)>.*$/, "$1");
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${msg.fromName.replace(/[<>"]/g, "")} via Onfile <${fromAddress}>`,
          to: [msg.to],
          subject: msg.subject,
          html,
          ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (res.ok) {
        status = "delivered";
        providerId = body.id ?? null;
      } else {
        status = "failed";
        error = body.message ?? `Provider responded ${res.status}`;
      }
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : "Email provider unreachable";
    }
  }

  await db.insert(emails).values({
    id,
    workspaceId: msg.workspaceId,
    envelopeId: msg.envelopeId ?? null,
    fileId: msg.fileId ?? null,
    kind: msg.kind,
    toEmail: msg.to,
    toName: msg.toName ?? "",
    subject: msg.subject,
    html,
    status,
    error,
    providerId,
  });
  return { id, status, error };
}
