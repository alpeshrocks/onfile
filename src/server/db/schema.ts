import { sql } from "drizzle-orm";
import { boolean, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type {
  Actor,
  EnvelopeField,
  EnvelopeStatus,
  Field,
  FieldValue,
  FileStatus,
  FirmSigner,
  PageSize,
  Role,
  SignerStatus,
  Variable,
  WorkspaceSettings,
} from "@/lib/types";

/**
 * Every tenant-owned table carries workspace_id and every query filters on it.
 * Documents live in Postgres (bytea) on purpose: one datastore to back up, one
 * transaction boundary for "signed PDF stored and file marked signed".
 */

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (v) => (v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer)),
  toDriver: (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength)),
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  brandColor: text("brand_color").notNull().default("#1B3FD8"),
  isDemo: boolean("is_demo").notNull().default(false),
  fileSeq: integer("file_seq").notNull().default(0),
  settings: jsonb("settings").$type<WorkspaceSettings>().notNull(),
  firmSigner: jsonb("firm_signer").$type<FirmSigner | null>(),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").$type<"owner" | "member">().notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email), index("users_workspace_idx").on(t.workspaceId)],
);

export const sessions = pgTable("sessions", {
  /** SHA-256 of the cookie value. The raw token is never stored. */
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});

export const invites = pgTable("invites", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdBy: text("created_by").notNull(),
  expiresAt: ts("expires_at").notNull(),
  acceptedAt: ts("accepted_at"),
  createdAt: createdAt(),
});

export const blobs = pgTable(
  "blobs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    contentType: text("content_type").notNull(),
    data: bytea("data").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("blobs_sha_idx").on(t.sha256)],
);

export const uploadChunks = pgTable(
  "upload_chunks",
  {
    uploadId: text("upload_id").notNull(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    data: bytea("data").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.uploadId, t.idx] })],
);

export const templates = pgTable(
  "templates",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").$type<"draft" | "active" | "archived">().notNull().default("draft"),
    isDefault: boolean("is_default").notNull().default(false),
    blobId: text("blob_id").notNull(),
    sha256: text("sha256").notNull(),
    pages: jsonb("pages").$type<PageSize[]>().notNull(),
    fields: jsonb("fields").$type<Field[]>().notNull().default(sql`'[]'::jsonb`),
    roles: jsonb("roles").$type<Role[]>().notNull(),
    variables: jsonb("variables").$type<Variable[]>().notNull().default(sql`'[]'::jsonb`),
    /** True once the browser has run field detection and saved the proposal. */
    detected: boolean("detected").notNull().default(false),
    version: integer("version").notNull().default(0),
    emailSubject: text("email_subject").notNull().default(""),
    emailMessage: text("email_message").notNull().default(""),
    publishedAt: ts("published_at"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("templates_workspace_idx").on(t.workspaceId)],
);

export const files = pgTable(
  "files",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    reference: text("reference").notNull(),
    title: text("title").notNull().default(""),
    clientName: text("client_name").notNull(),
    clientEmail: text("client_email").notNull(),
    status: text("status").$type<FileStatus>().notNull().default("draft"),
    /** Id in the firm's own system. Makes API and CSV imports idempotent. */
    externalId: text("external_id"),
    source: text("source").$type<"manual" | "api" | "csv" | "demo">().notNull().default("manual"),
    variables: jsonb("variables").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    createdBy: text("created_by"),
    createdByEmail: text("created_by_email"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("files_reference_idx").on(t.workspaceId, t.reference),
    uniqueIndex("files_external_idx").on(t.workspaceId, t.externalId),
    index("files_status_idx").on(t.workspaceId, t.status, t.createdAt),
  ],
);

export const envelopes = pgTable(
  "envelopes",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    fileId: text("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    /** Public document id printed on every page and used for verification. */
    docId: text("doc_id").notNull().unique(),
    templateId: text("template_id").notNull(),
    templateName: text("template_name").notNull(),
    templateVersion: integer("template_version").notNull(),
    sourceBlobId: text("source_blob_id").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    pages: jsonb("pages").$type<PageSize[]>().notNull(),
    fields: jsonb("fields").$type<EnvelopeField[]>().notNull(),
    status: text("status").$type<EnvelopeStatus>().notNull().default("sent"),
    sentAt: ts("sent_at").notNull().defaultNow(),
    completedAt: ts("completed_at"),
    expiresAt: ts("expires_at"),
    signedBlobId: text("signed_blob_id"),
    signedSha256: text("signed_sha256"),
    reminderCount: integer("reminder_count").notNull().default(0),
    lastReminderAt: ts("last_reminder_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("envelopes_file_idx").on(t.fileId),
    index("envelopes_open_idx").on(t.status, t.sentAt),
    index("envelopes_signed_sha_idx").on(t.signedSha256),
  ],
);

export const signers = pgTable(
  "signers",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    envelopeId: text("envelope_id").notNull().references(() => envelopes.id, { onDelete: "cascade" }),
    roleKey: text("role_key").notNull(),
    roleLabel: text("role_label").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    /** Lookup is by hash; the link itself is kept encrypted so staff can copy it again. */
    tokenHash: text("token_hash").notNull().unique(),
    tokenEnc: text("token_enc").notNull(),
    status: text("status").$type<SignerStatus>().notNull().default("pending"),
    viewedAt: ts("viewed_at"),
    consentedAt: ts("consented_at"),
    signedAt: ts("signed_at"),
    declinedAt: ts("declined_at"),
    declineReason: text("decline_reason"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    values: jsonb("values").$type<Record<string, FieldValue>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [index("signers_envelope_idx").on(t.envelopeId)],
);

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    envelopeId: text("envelope_id").notNull().references(() => envelopes.id, { onDelete: "cascade" }),
    fileId: text("file_id").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    actor: jsonb("actor").$type<Actor>().notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: ts("created_at").notNull(),
    /** Hash chain: each event commits to the one before it. */
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [uniqueIndex("events_envelope_seq_idx").on(t.envelopeId, t.seq), index("events_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const emails = pgTable(
  "emails",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    envelopeId: text("envelope_id"),
    fileId: text("file_id"),
    kind: text("kind").notNull(),
    toEmail: text("to_email").notNull(),
    toName: text("to_name").notNull().default(""),
    subject: text("subject").notNull(),
    html: text("html").notNull(),
    /** delivered: accepted by the provider. captured: no provider configured, kept in the Outbox. */
    status: text("status").$type<"delivered" | "captured" | "failed">().notNull(),
    error: text("error"),
    providerId: text("provider_id"),
    createdAt: createdAt(),
  },
  (t) => [index("emails_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
  createdAt: createdAt(),
});

export const webhooks = pgTable("webhooks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  secretEnc: text("secret_enc").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    webhookId: text("webhook_id").notNull().references(() => webhooks.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    statusCode: integer("status_code"),
    ok: boolean("ok").notNull(),
    error: text("error"),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
  },
  (t) => [index("deliveries_webhook_idx").on(t.webhookId, t.createdAt)],
);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: ts("window_start").notNull(),
  count: integer("count").notNull(),
});

export type Workspace = typeof workspaces.$inferSelect;
export type User = typeof users.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type Envelope = typeof envelopes.$inferSelect;
export type Signer = typeof signers.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type EmailRow = typeof emails.$inferSelect;
