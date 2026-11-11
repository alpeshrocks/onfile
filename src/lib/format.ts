export function formatDate(d: Date | string | null | undefined, opts: Intl.DateTimeFormatOptions = {}) {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", ...opts });
}

export function formatDateTime(d: Date | string | null | undefined, timeZone?: string) {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}

/** Long form date used on the agreement itself, in the given IANA time zone. */
export function longDate(d: Date, timeZone?: string) {
  const safe = isValidTimeZone(timeZone) ? timeZone : "UTC";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: safe });
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function utcStamp(d: Date | string) {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function timeAgo(d: Date | string | null | undefined, now = new Date()) {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  const s = Math.round((now.getTime() - date.getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  if (s < 86400 * 30) {
    const days = Math.round(s / 86400);
    return days === 1 ? "yesterday" : `${days} days ago`;
  }
  return formatDate(date);
}

export function formatDuration(ms: number | null | undefined) {
  if (ms == null || !isFinite(ms)) return "";
  const min = ms / 60000;
  if (min < 1) return "under a minute";
  if (min < 90) return `${Math.round(min)} min`;
  const hr = min / 60;
  if (hr < 36) return `${Math.round(hr * 10) / 10} hr`;
  return `${Math.round((hr / 24) * 10) / 10} days`;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function slugKey(label: string) {
  const key = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return /^[a-z]/.test(key) ? key : `v_${key || "field"}`;
}

/** Hide most of an email address on public pages. */
export function maskEmail(email: string) {
  const [user, domain] = email.split("@");
  if (!domain) return "hidden";
  return `${user.slice(0, 1)}${"*".repeat(Math.max(2, Math.min(6, user.length - 1)))}@${domain}`;
}

export const EVENT_LABEL: Record<string, string> = {
  "agreement.sent": "Agreement sent",
  "agreement.viewed": "Agreement opened",
  "agreement.consented": "Agreed to sign electronically",
  "agreement.signed": "Signed",
  "agreement.completed": "All signatures collected",
  "agreement.declined": "Declined to sign",
  "agreement.voided": "Voided",
  "agreement.expired": "Expired",
  "agreement.reminded": "Reminder sent",
  "agreement.firm_signed": "Firm signature applied",
  "agreement.downloaded": "Signed copy downloaded",
};
