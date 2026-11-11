import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomString(alphabet: string, length: number) {
  // Rejection sampling keeps the distribution uniform.
  const max = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < max) out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Prefixed ids read well in logs and URLs: file_8sK2..., env_..., tpl_... */
export function newId(prefix: string) {
  return `${prefix}_${randomString(BASE62, 18)}`;
}

/** Human friendly public document id, for example ONF-7K2M-9QXA-41TD. */
export function newDocId() {
  const s = randomString(CROCKFORD, 12);
  return `ONF-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/** 256 bits of entropy, URL safe. Used for signing links, sessions and API keys. */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(data: string | Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

export function hmacHex(secret: string, payload: string) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}

export function appSecret(): string {
  const explicit = process.env.APP_SECRET;
  if (explicit && explicit.length >= 16) return explicit;
  // A hosted deployment without APP_SECRET still gets a stable, private key derived from
  // its database credentials, so a missing variable cannot take signing links down.
  if (process.env.DATABASE_URL) return sha256Hex(`onfile:${process.env.DATABASE_URL}`);
  return "onfile-local-development-secret-not-for-production";
}

function key() {
  return createHash("sha256").update(appSecret()).digest();
}

/** AES-256-GCM. Output is iv.tag.ciphertext, base64url. */
export function encrypt(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(payload: string) {
  const [iv, tag, data] = payload.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** JSON with sorted keys, so the same event always hashes to the same value. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}
