import { z } from "zod";

/**
 * Domain vocabulary shared by the browser, the server and the tests.
 *
 * A Template is one agreement (a PDF plus the fields laid over it).
 * A File is one job or case for one client.
 * An Envelope is one sending of a template for one file; it snapshots the fields,
 * so later template edits never change an agreement that is already out for signature.
 */

export const FIELD_TYPES = ["signature", "initials", "date", "name", "text", "checkbox"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Fields assigned to AUTO are filled by Onfile the moment the agreement is sent. */
export const AUTO = "auto";

export const fieldSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(FIELD_TYPES),
  page: z.number().int().min(0).max(500),
  // Normalized to the page as displayed (rotation applied), origin top left.
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0.005).max(1),
  h: z.number().min(0.004).max(1),
  /** AUTO, or the key of a signer role such as "client". */
  assignee: z.string().min(1).max(40),
  required: z.boolean(),
  label: z.string().max(80).optional(),
  /** For AUTO text fields: which variable supplies the value. */
  variable: z.string().max(60).optional(),
  /** Paint a white box under the value, to cover placeholder text such as [Client Name]. */
  mask: z.boolean().optional(),
  /** Font size in points. Omitted means sized from the box height. */
  fontSize: z.number().min(5).max(36).optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.enum(["detected", "form", "manual", "generated"]).optional(),
});
export type Field = z.infer<typeof fieldSchema>;

export const roleSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/),
  label: z.string().min(1).max(40),
});
export type Role = z.infer<typeof roleSchema>;

export const variableSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  label: z.string().min(1).max(60),
  required: z.boolean().default(true),
});
export type Variable = z.infer<typeof variableSchema>;

export const DEFAULT_ROLES: Role[] = [{ key: "client", label: "Client" }];

/** Variables every workspace gets for free. Custom ones are defined per template. */
export const BUILTIN_VARIABLES: { key: string; label: string; hint: string }[] = [
  { key: "client_name", label: "Client name", hint: "Name of the first signer" },
  { key: "client_email", label: "Client email", hint: "Email of the first signer" },
  { key: "file_reference", label: "File reference", hint: "Your file or case number" },
  { key: "file_title", label: "File title", hint: "Short description of the job" },
  { key: "sent_date", label: "Date sent", hint: "The day the agreement goes out" },
  { key: "firm_name", label: "Firm name", hint: "Your company name" },
  { key: "firm_signer_name", label: "Firm signer name", hint: "Who signs for your firm" },
  { key: "firm_signer_title", label: "Firm signer title", hint: "Their title" },
];

export const signatureValueSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("drawn"),
    /** Each stroke is a flat [x0, y0, x1, y1, ...] list inside a width by height box. */
    strokes: z.array(z.array(z.number().finite()).min(2).max(8000)).min(1).max(400),
    width: z.number().positive().max(4000),
    height: z.number().positive().max(4000),
  }),
  z.object({
    kind: z.literal("typed"),
    text: z.string().min(1).max(120),
    /** PNG rendering of the typed name in the chosen handwriting face. */
    dataUrl: z
      .string()
      .max(600_000)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
    width: z.number().positive().max(4000),
    height: z.number().positive().max(4000),
  }),
]);
export type SignatureValue = z.infer<typeof signatureValueSchema>;

export type FieldValue = string | boolean | SignatureValue;

/** A field as stored on an envelope: AUTO fields carry their resolved value. */
export type EnvelopeField = Field & { value?: FieldValue };

export interface PageSize {
  /** Displayed size in PDF points (rotation applied). */
  width: number;
  height: number;
}

export interface FirmSigner {
  name: string;
  title: string;
  signature: SignatureValue;
}

export interface WorkspaceSettings {
  /** Days after sending on which an automatic reminder goes out. */
  reminderDays: number[];
  /** Days until an unsigned agreement expires. 0 disables expiry. */
  expiryDays: number;
  /** Where "agreement signed" notices go. Empty means the person who opened the file. */
  notifyEmail: string;
  replyTo: string;
  /** IANA zone used for dates printed on agreements when they are sent. */
  timeZone: string;
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  reminderDays: [2, 5, 9],
  expiryDays: 30,
  notifyEmail: "",
  replyTo: "",
  timeZone: "America/New_York",
};

export type FileStatus = "draft" | "awaiting_signature" | "signed" | "declined" | "voided" | "expired";
export type EnvelopeStatus = "sent" | "partially_signed" | "completed" | "declined" | "voided" | "expired";
export type SignerStatus = "pending" | "viewed" | "signed" | "declined";

export interface Actor {
  kind: "user" | "signer" | "system" | "api";
  name: string;
  email?: string;
}

export const FILE_STATUS_LABEL: Record<FileStatus, string> = {
  draft: "Not sent",
  awaiting_signature: "Awaiting signature",
  signed: "Signed",
  declined: "Declined",
  voided: "Voided",
  expired: "Expired",
};

export type ActionResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };
