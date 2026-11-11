import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { isValidTimeZone } from "@/lib/format";
import { DEFAULT_SETTINGS, signatureValueSchema, type WorkspaceSettings } from "@/lib/types";
import { AppError, type Ctx } from "../context";
import { decrypt, encrypt, hashPassword, newId, randomToken, sha256Hex, verifyPassword } from "../crypto";
import { getDb } from "../db";
import { apiKeys, invites, passwordResets, sessions, users, webhookDeliveries, webhooks, workspaces } from "../db/schema";
import { emailConfigured, sendEmail } from "../email";
import { isSafeWebhookUrl } from "../webhooks";

export const SESSION_DAYS = 30;

const email = z.string().trim().toLowerCase().email("Enter a valid email address.").max(200);
const password = z.string().min(8, "Use at least 8 characters.").max(200);

export const signupInput = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(120),
  company: z.string().trim().min(1, "Enter your company name.").max(120),
  email,
  password,
  timeZone: z.string().max(64).optional(),
});

async function startSession(userId: string) {
  const db = await getDb();
  const token = randomToken(32);
  await db.insert(sessions).values({ id: sha256Hex(token), userId, expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) });
  return token;
}

export async function signup(raw: unknown, opts: { demo?: boolean } = {}) {
  const input = signupInput.parse(raw);
  const db = await getDb();
  const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
  if (taken) throw new AppError("An account with this email already exists. Sign in instead.", "email_taken", 409);

  const workspaceId = newId("ws");
  const userId = newId("usr");
  const passwordHash = await hashPassword(input.password);
  await db.transaction(async (tx) => {
    await tx.insert(workspaces).values({
      id: workspaceId,
      name: input.company,
      isDemo: Boolean(opts.demo),
      settings: { ...DEFAULT_SETTINGS, timeZone: isValidTimeZone(input.timeZone) ? input.timeZone : DEFAULT_SETTINGS.timeZone },
    });
    await tx.insert(users).values({ id: userId, workspaceId, email: input.email, name: input.name, passwordHash, role: "owner" });
  });
  return { workspaceId, userId, token: await startSession(userId) };
}

export async function login(raw: unknown) {
  const input = z.object({ email, password: z.string().min(1).max(200) }).parse(raw);
  const db = await getDb();
  const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
  // Verify against a dummy hash when the user is unknown so timing does not reveal accounts.
  const ok = await verifyPassword(input.password, user?.passwordHash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==");
  if (!user || !ok) throw new AppError("That email and password do not match.", "bad_credentials", 401);
  return { userId: user.id, token: await startSession(user.id) };
}

export async function sessionFromToken(token: string | undefined) {
  if (!token) return null;
  const db = await getDb();
  const [row] = await db
    .select({ user: users, workspace: workspaces, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(workspaces, eq(workspaces.id, users.workspaceId))
    .where(and(eq(sessions.id, sha256Hex(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function endSession(token: string | undefined) {
  if (!token) return;
  const db = await getDb();
  await db.delete(sessions).where(eq(sessions.id, sha256Hex(token)));
}

export async function getWorkspace(ctx: Ctx) {
  const db = await getDb();
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1);
  return ws;
}

const settingsInput = z.object({
  name: z.string().trim().min(1).max(120),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a valid color."),
  reminderDays: z
    .array(z.number().int().min(1).max(90))
    .max(6)
    .transform((d) => [...new Set(d)].sort((a, b) => a - b)),
  expiryDays: z.number().int().min(0).max(365),
  notifyEmail: z.union([z.literal(""), email]),
  replyTo: z.union([z.literal(""), email]),
  timeZone: z.string().refine(isValidTimeZone, "Unknown time zone."),
});

export async function updateSettings(ctx: Ctx, raw: unknown) {
  const input = settingsInput.parse(raw);
  const db = await getDb();
  const settings: WorkspaceSettings = {
    reminderDays: input.reminderDays,
    expiryDays: input.expiryDays,
    notifyEmail: input.notifyEmail,
    replyTo: input.replyTo,
    timeZone: input.timeZone,
  };
  await db.update(workspaces).set({ name: input.name, brandColor: input.brandColor, settings }).where(eq(workspaces.id, ctx.workspaceId));
}

const firmSignerInput = z.object({
  name: z.string().trim().min(1, "Enter the signer's name.").max(120),
  title: z.string().trim().max(120),
  signature: signatureValueSchema,
});

/**
 * The firm's standing signature. Set once by an authorized person, then applied to every
 * agreement automatically, so nobody at the firm has to countersign file by file.
 */
export async function setFirmSigner(ctx: Ctx, raw: unknown) {
  const input = firmSignerInput.parse(raw);
  const db = await getDb();
  await db.update(workspaces).set({ firmSigner: input }).where(eq(workspaces.id, ctx.workspaceId));
}

// ---- Team -------------------------------------------------------------------

export async function listMembers(ctx: Ctx) {
  const db = await getDb();
  return db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.workspaceId, ctx.workspaceId))
    .orderBy(users.createdAt);
}

export async function createInvite(ctx: Ctx) {
  const db = await getDb();
  const token = randomToken(24);
  await db.insert(invites).values({
    id: newId("inv"),
    workspaceId: ctx.workspaceId,
    tokenHash: sha256Hex(token),
    createdBy: ctx.userId ?? "",
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
  });
  return `${ctx.baseUrl}/join/${token}`;
}

export async function findInvite(token: string) {
  const db = await getDb();
  const [row] = await db
    .select({ invite: invites, workspace: workspaces })
    .from(invites)
    .innerJoin(workspaces, eq(workspaces.id, invites.workspaceId))
    .where(and(eq(invites.tokenHash, sha256Hex(token)), isNull(invites.acceptedAt), gt(invites.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function acceptInvite(token: string, raw: unknown) {
  const input = z.object({ name: z.string().trim().min(1, "Enter your name.").max(120), email, password }).parse(raw);
  const found = await findInvite(token);
  if (!found) throw new AppError("This invitation has expired or was already used.", "invite_invalid", 410);
  const db = await getDb();
  const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
  if (taken) throw new AppError("An account with this email already exists.", "email_taken", 409);
  const userId = newId("usr");
  const passwordHash = await hashPassword(input.password);
  await db.transaction(async (tx) => {
    await tx.insert(users).values({ id: userId, workspaceId: found.workspace.id, email: input.email, name: input.name, passwordHash, role: "member" });
    await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, found.invite.id));
  });
  return { token: await startSession(userId) };
}

/** Remove a teammate. Their sessions end immediately; files they opened stay. */
export async function removeMember(ctx: Ctx, actorRole: string, userId: string) {
  if (actorRole !== "owner") throw new AppError("Only the workspace owner can remove teammates.", "forbidden", 403);
  if (userId === ctx.userId) throw new AppError("You cannot remove yourself.", "conflict", 409);
  const db = await getDb();
  const removed = await db
    .delete(users)
    .where(and(eq(users.id, userId), eq(users.workspaceId, ctx.workspaceId)))
    .returning({ id: users.id });
  if (!removed.length) throw new AppError("Teammate not found.", "not_found", 404);
}

// ---- Password reset ---------------------------------------------------------

const RESET_MINUTES = 60;

async function mintReset(userId: string) {
  const db = await getDb();
  const token = randomToken(32);
  await db.insert(passwordResets).values({ id: newId("rst"), userId, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + RESET_MINUTES * 60_000) });
  return token;
}

/**
 * "Forgot password". Always answers the same way whether or not the address has an
 * account. With no mail provider configured nothing is minted, because a link that cannot
 * be delivered privately should not exist; the owner can issue one instead.
 */
export async function requestPasswordReset(rawEmail: unknown, baseUrl: string) {
  const address = email.parse(rawEmail);
  if (!emailConfigured()) return { delivery: false };
  const db = await getDb();
  const [row] = await db
    .select({ user: users, workspace: workspaces })
    .from(users)
    .innerJoin(workspaces, eq(workspaces.id, users.workspaceId))
    .where(eq(users.email, address))
    .limit(1);
  if (row) {
    const token = await mintReset(row.user.id);
    await sendEmail(db, {
      workspaceId: row.workspace.id,
      kind: "password_reset",
      to: row.user.email,
      toName: row.user.name,
      fromName: "Onfile",
      subject: "Reset your Onfile password",
      private: true,
      content: {
        firmName: row.workspace.name,
        brandColor: row.workspace.brandColor,
        heading: "Reset your password",
        paragraphs: [`Hello ${row.user.name.split(" ")[0]},`, `Use the button below to choose a new password. The link works once and expires in ${RESET_MINUTES} minutes. If you did not ask for this, you can ignore this message.`],
        cta: { label: "Choose a new password", url: `${baseUrl}/reset/${token}` },
      },
    });
  }
  return { delivery: true };
}

/** An owner issues a one-time reset link for a teammate, to hand over directly. */
export async function createResetLink(ctx: Ctx, actorRole: string, userId: string) {
  if (actorRole !== "owner") throw new AppError("Only the workspace owner can issue reset links.", "forbidden", 403);
  const db = await getDb();
  const [member] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.workspaceId, ctx.workspaceId)))
    .limit(1);
  if (!member) throw new AppError("Teammate not found.", "not_found", 404);
  return `${ctx.baseUrl}/reset/${await mintReset(member.id)}`;
}

export async function findReset(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const db = await getDb();
  const [row] = await db
    .select({ reset: passwordResets, name: users.name })
    .from(passwordResets)
    .innerJoin(users, eq(users.id, passwordResets.userId))
    .where(and(eq(passwordResets.tokenHash, sha256Hex(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

/** Set a new password. The link is spent and every existing session is signed out. */
export async function resetPassword(token: string, raw: unknown) {
  const input = z.object({ password }).parse(raw);
  const found = await findReset(token);
  if (!found) throw new AppError("This reset link has expired or was already used.", "reset_invalid", 410);
  const passwordHash = await hashPassword(input.password);
  const db = await getDb();
  await db.transaction(async (tx) => {
    const spent = await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.id, found.reset.id), isNull(passwordResets.usedAt)))
      .returning({ id: passwordResets.id });
    if (!spent.length) throw new AppError("This reset link has expired or was already used.", "reset_invalid", 410);
    await tx.update(users).set({ passwordHash }).where(eq(users.id, found.reset.userId));
    await tx.delete(sessions).where(eq(sessions.userId, found.reset.userId));
  });
  return { token: await startSession(found.reset.userId) };
}

// ---- API keys ---------------------------------------------------------------

export async function createApiKey(ctx: Ctx, name: string) {
  const db = await getDb();
  const secret = `onf_live_${randomToken(30)}`;
  const id = newId("key");
  await db.insert(apiKeys).values({
    id,
    workspaceId: ctx.workspaceId,
    name: name.trim().slice(0, 60) || "API key",
    prefix: secret.slice(0, 14),
    keyHash: sha256Hex(secret),
  });
  return { id, secret };
}

export async function listApiKeys(ctx: Ctx) {
  const db = await getDb();
  return db
    .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, lastUsedAt: apiKeys.lastUsedAt, createdAt: apiKeys.createdAt })
    .from(apiKeys)
    .where(and(eq(apiKeys.workspaceId, ctx.workspaceId), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt));
}

export async function revokeApiKey(ctx: Ctx, id: string) {
  const db = await getDb();
  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, ctx.workspaceId)));
}

export async function workspaceFromApiKey(secret: string) {
  if (!secret.startsWith("onf_live_")) return null;
  const db = await getDb();
  const [row] = await db
    .select({ key: apiKeys, workspace: workspaces })
    .from(apiKeys)
    .innerJoin(workspaces, eq(workspaces.id, apiKeys.workspaceId))
    .where(and(eq(apiKeys.keyHash, sha256Hex(secret)), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!row) return null;
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.key.id));
  return row;
}

// ---- Webhooks ---------------------------------------------------------------

export async function createWebhook(ctx: Ctx, url: string) {
  const clean = url.trim();
  if (!isSafeWebhookUrl(clean)) throw new AppError("Enter a public https URL.", "invalid_url", 422);
  const db = await getDb();
  const secret = `whsec_${randomToken(24)}`;
  const id = newId("wh");
  await db.insert(webhooks).values({ id, workspaceId: ctx.workspaceId, url: clean, secretEnc: encrypt(secret) });
  return { id, secret };
}

export async function listWebhooks(ctx: Ctx) {
  const db = await getDb();
  const hooks = await db.select().from(webhooks).where(eq(webhooks.workspaceId, ctx.workspaceId)).orderBy(desc(webhooks.createdAt));
  const deliveries = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.workspaceId, ctx.workspaceId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(25);
  return {
    hooks: hooks.map((h) => ({ id: h.id, url: h.url, active: h.active, createdAt: h.createdAt, secret: decrypt(h.secretEnc) })),
    deliveries: deliveries.map((d) => ({ id: d.id, webhookId: d.webhookId, eventType: d.eventType, ok: d.ok, statusCode: d.statusCode, error: d.error, durationMs: d.durationMs, createdAt: d.createdAt })),
  };
}

export async function deleteWebhook(ctx: Ctx, id: string) {
  const db = await getDb();
  await db.delete(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.workspaceId, ctx.workspaceId)));
}
