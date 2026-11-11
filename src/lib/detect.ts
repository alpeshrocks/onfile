import { clampRect, overlapRatio } from "./geometry";
import { slugKey } from "./format";
import { AUTO, BUILTIN_VARIABLES, DEFAULT_ROLES, type Field, type FieldType, type Role, type Variable } from "./types";

/**
 * Field detection for agreements Onfile has never seen.
 *
 * Input is positioned text (from pdf.js, in the browser) plus any real PDF form widgets.
 * Output is a proposed set of fields that a person confirms in the editor. The engine is
 * deterministic and pure: the same document always yields the same proposal, it runs in
 * the browser and in tests, and no document text leaves the customer's session.
 *
 * It recognizes, in order of confidence:
 *   1. PDF form widgets (signature, text and checkbox fields authored into the PDF).
 *   2. Blank lines made of underscores or dot leaders, labelled by nearby text
 *      ("Signature: ____", or a label printed under the line).
 *   3. Placeholder tokens such as [Client Name] or {{file_number}}.
 *   4. Labels that sit next to or under a drawn rule ("Signature:" with nothing after it).
 * and it assigns each field to the client, a co-signer, or the firm by reading the words
 * around it ("Client", "Insured", "For the Company", the firm's own name).
 */

export interface TextItem {
  str: string;
  /** Normalized to the displayed page, y is the top of the glyph box. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageText {
  page: number;
  /** Displayed size in points. */
  width: number;
  height: number;
  items: TextItem[];
}

export interface FormWidget {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "signature" | "text" | "checkbox";
  name: string;
}

export interface Detection {
  fields: Field[];
  roles: Role[];
  variables: Variable[];
  hasText: boolean;
}

interface Ch {
  c: string;
  x0: number;
  x1: number;
}
interface Chunk {
  id: number;
  text: string;
  chars: Ch[];
  x0: number;
  x1: number;
  y: number;
  h: number;
  line: number;
  page: number;
}

type Kind = "signature" | "initials" | "date" | "name" | "title" | "email" | "info" | "firm_name" | "other";
type RoleHint = "client" | "client2" | "firm" | null;

const FIRM_WORDS =
  /\b(company|firm|contractor|adjuster|agent|agency|representative|provider|consultant|attorney|advisor|vendor|authorized (signer|signatory|agent|signature|representative)|on behalf of)\b/i;
const CLIENT_WORDS =
  /\b(client|customer|insured|owner|homeowner|policyholder|policy holder|claimant|tenant|patient|borrower|buyer|member|participant|undersigned|applicant|guardian)\b/i;
const CO_WORDS =
  /\b(co-?\s?(client|owner|signer|applicant|insured|borrower)|spouse|second (client|owner|signer|insured)|(client|owner|signer|insured)\s*#?\s*(2|two))\b/i;
const NOT_A_LABEL = /\b(page|pages|follows|block|section|required|below|above)\b/i;
const NOT_A_TOKEN = /page|seal|remainder|intentionally|follows|signature|redacted|omitted/i;

/** Approximate advance widths (per 1000 em) of a common sans face, used to place characters inside a run. */
export function charWidth(c: string): number {
  if (c === " ") return 278;
  if (c === "_") return 556;
  if (/[0-9]/.test(c)) return 556;
  if (/[iljtfI.,;:'!|]/.test(c)) return 278;
  if (/[mwMW]/.test(c)) return 833;
  if (/[A-Z]/.test(c)) return 667;
  if (/[a-z]/.test(c)) return 520;
  return 556;
}

function buildChunks(page: PageText): { chunks: Chunk[]; lines: Chunk[][] } {
  const items = page.items.filter((i) => i.str.length > 0 && i.w >= 0 && i.h > 0);
  items.sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);

  const rows: TextItem[][] = [];
  for (const item of items) {
    const row = rows[rows.length - 1];
    const cy = item.y + item.h / 2;
    if (row) {
      const ref = row[0];
      if (Math.abs(cy - (ref.y + ref.h / 2)) < 0.55 * Math.max(ref.h, item.h)) {
        row.push(item);
        continue;
      }
    }
    rows.push([item]);
  }

  const chunks: Chunk[] = [];
  const lines: Chunk[][] = [];
  let id = 0;
  rows.forEach((row, lineIndex) => {
    row.sort((a, b) => a.x - b.x);
    const line: Chunk[] = [];
    let current: Chunk | null = null;
    for (const item of row) {
      if (item.str.trim() === "") {
        // pdf.js reports the gap between columns as one wide whitespace run. Wide runs
        // end the chunk (so side by side signature blocks stay separate); narrow ones
        // are just a space.
        if (item.w > 0.03) current = null;
        else if (current && !current.text.endsWith(" ")) {
          current.chars.push({ c: " ", x0: current.x1, x1: item.x + item.w });
          current.text += " ";
          current.x1 = Math.max(current.x1, item.x + item.w);
        }
        continue;
      }
      const gap: number = current ? item.x - current.x1 : 0;
      if (!current || gap > 0.03) {
        current = { id: id++, text: "", chars: [], x0: item.x, x1: item.x, y: item.y, h: item.h, line: lineIndex, page: page.page };
        line.push(current);
      } else if (gap > 0.004 && !current.text.endsWith(" ") && !item.str.startsWith(" ")) {
        current.chars.push({ c: " ", x0: current.x1, x1: item.x });
        current.text += " ";
      }
      const total = [...item.str].reduce((s, c) => s + charWidth(c), 0) || 1;
      let cursor = item.x;
      for (const c of item.str) {
        const w = (charWidth(c) / total) * item.w;
        current.chars.push({ c, x0: cursor, x1: cursor + w });
        cursor += w;
      }
      current.text += item.str;
      current.x1 = Math.max(current.x1, item.x + item.w);
      current.y = Math.min(current.y, item.y);
      current.h = Math.max(current.h, item.h);
    }
    for (const c of line) if (c.text.trim()) chunks.push(c);
    lines.push(line.filter((c) => c.text.trim()));
  });
  return { chunks, lines };
}

function classify(phrase: string): Kind {
  const p = phrase
    .toLowerCase()
    .replace(/[_.:()[\]*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!p) return "other";
  if (/\binitials?\b/.test(p)) return "initials";
  if (/\b(signature|sign here|signed|sign)\b/.test(p) || /^(by|x)$/.test(p) || /\bby$/.test(p)) return "signature";
  if (/\b(date|dated)\b/.test(p)) return "date";
  if (/\b(company|firm|business) name\b/.test(p)) return "firm_name";
  if (/\bname\b/.test(p)) return "name";
  if (/\btitle\b/.test(p)) return "title";
  if (/\be-?mail\b/.test(p)) return "email";
  if (/\b(address|phone|telephone|mobile|cell|city|state|zip|postal)\b/.test(p)) return "info";
  return "other";
}

function roleOf(phrase: string, firmName: RegExp | null): RoleHint {
  if (CO_WORDS.test(phrase)) return "client2";
  if (CLIENT_WORDS.test(phrase)) return "client";
  if (FIRM_WORDS.test(phrase)) return "firm";
  if (firmName && firmName.test(phrase)) return "firm";
  return null;
}

function firmNamePattern(name?: string): RegExp | null {
  if (!name) return null;
  const generic = new Set(["the", "and", "inc", "llc", "ltd", "group", "company", "services", "co", "corp", "of"]);
  const tokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !generic.has(t));
  if (!tokens.length) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(${esc(name.toLowerCase())}|${esc(tokens[0])})\\b`, "i");
}

function tailWords(text: string, n: number) {
  return text.trim().split(/\s+/).slice(-n).join(" ");
}
function headWords(text: string, n: number) {
  return text.trim().split(/\s+/).slice(0, n).join(" ");
}
function titleCase(text: string) {
  const t = text
    .replace(/[_:()[\]"“”*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

const TOKEN_VARIABLES: [RegExp, string][] = [
  [/^(client|customer|insured|owner|homeowner|policyholder|claimant)('s)?( full)?( name)?$|^(full )?name$/i, "client_name"],
  [/^(client |customer )?e-?mail( address)?$/i, "client_email"],
  [/^(today'?s? )?date$|^effective date$|^agreement date$/i, "sent_date"],
  [/^(file|case|claim|matter|job|reference|ref|project)( (number|no\.?|#|id|reference))?$/i, "file_reference"],
  [/^(company|firm|business)( name)?$/i, "firm_name"],
];

export function detectFields(pages: PageText[], widgets: FormWidget[] = [], opts: { firmName?: string } = {}): Detection {
  const firmName = firmNamePattern(opts.firmName);
  const proposals: Field[] = [];
  const variables = new Map<string, Variable>();
  const builtin = new Set(BUILTIN_VARIABLES.map((v) => v.key));
  let blankCounter = 0;
  let hasText = false;

  const customVariable = (label: string): string => {
    const clean = titleCase(label).slice(0, 48) || `Blank ${++blankCounter}`;
    let key = slugKey(clean);
    if (builtin.has(key)) return key;
    let n = 2;
    while (variables.has(key) && variables.get(key)!.label !== clean) key = `${slugKey(clean)}_${n++}`;
    variables.set(key, { key, label: clean, required: true });
    return key;
  };

  const make = (
    page: number,
    rect: { x: number; y: number; w: number; h: number },
    kind: Kind,
    role: RoleHint,
    label: string,
    confidence: number,
    extra: Partial<Field> = {},
  ): Field => {
    const firm = role === "firm";
    const signerKey = role === "client2" ? "client2" : "client";
    let type: FieldType = "text";
    let assignee = firm ? AUTO : signerKey;
    let variable: string | undefined;
    let required = true;
    let fieldLabel: string | undefined = titleCase(label).slice(0, 60) || undefined;

    switch (kind) {
      case "signature":
      case "initials":
      case "date":
        type = kind;
        fieldLabel = undefined;
        break;
      case "name":
        if (firm) {
          type = "text";
          variable = "firm_signer_name";
        } else type = "name";
        break;
      case "title":
        if (firm) variable = "firm_signer_title";
        else required = false;
        break;
      case "email":
        assignee = AUTO;
        variable = firm ? customVariable(label || "Firm email") : role === "client2" ? undefined : "client_email";
        if (!variable) {
          assignee = signerKey;
          required = false;
        }
        break;
      case "firm_name":
        assignee = AUTO;
        variable = "firm_name";
        break;
      case "info":
        if (firm) variable = customVariable(label);
        else required = false;
        break;
      case "other":
        assignee = AUTO;
        variable = customVariable(label);
        break;
    }
    return {
      id: "",
      type,
      page,
      ...clampRect(rect),
      assignee,
      required,
      ...(fieldLabel && type === "text" ? { label: fieldLabel } : {}),
      ...(variable ? { variable } : {}),
      confidence,
      source: "detected",
      ...extra,
    };
  };

  const sized = (kind: Kind, x0: number, x1: number, bottom: number, lineH: number) => {
    if (kind === "signature") {
      const h = Math.min(0.07, Math.max(0.042, lineH * 2.6));
      return { x: x0, w: Math.max(0.08, x1 - x0), y: bottom - h + 0.003, h };
    }
    if (kind === "initials") {
      const h = Math.min(0.04, Math.max(0.028, lineH * 1.9));
      return { x: x0, w: Math.min(Math.max(0.05, x1 - x0), 0.12), y: bottom - h + 0.003, h };
    }
    const h = Math.min(0.03, Math.max(0.017, lineH * 1.55));
    const w = kind === "date" ? Math.min(Math.max(0.06, x1 - x0), 0.24) : Math.max(0.04, x1 - x0);
    return { x: x0, w, y: bottom - h + 0.002, h };
  };

  for (const page of pages) {
    const { chunks, lines } = buildChunks(page);
    if (chunks.length) hasText = true;
    const used = new Set<number>();

    // Short role-bearing chunks act as headers for the signature block beneath them.
    const headers = chunks
      .map((c) => ({ c, role: c.text.trim().split(/\s+/).length <= 6 ? roleOf(c.text.replace(/_+/g, " "), firmName) : null }))
      .filter((h) => h.role) as { c: Chunk; role: Exclude<RoleHint, null> }[];

    /**
     * Which party a field belongs to when its own label does not say: the nearest role
     * header above it, measured as vertical distance plus horizontal gap. Stacked blocks
     * resolve on the vertical term, side by side blocks on the horizontal one. Headers that
     * start to the right of the field belong to another column and are ignored.
     */
    const blockRole = (x0: number, _x1: number, y: number): RoleHint => {
      let best: { role: RoleHint; d: number } | null = null;
      for (const { c, role } of headers) {
        const dy = y - c.y;
        if (dy < -0.004 || dy > 0.22) continue;
        if (c.x0 > x0 + 0.06) continue;
        // Distance from the header's right edge: zero for a header in the field's own
        // column, large for one that belongs to the column on the left.
        const d = dy + Math.max(0, x0 - c.x1);
        if (!best || d < best.d) best = { role, d };
      }
      return best?.role ?? null;
    };

    /** Clear space above a blank, so a tall signature box does not sit on the line above. */
    const roomAbove = (x0: number, x1: number, bottom: number, self: Chunk) => {
      let nearest = Infinity;
      for (const other of chunks) {
        if (other.id === self.id || other.line >= self.line) continue;
        if (other.x0 >= x1 || other.x1 <= x0) continue;
        const gap = bottom - (other.y + other.h);
        if (gap > 0) nearest = Math.min(nearest, gap);
      }
      return nearest;
    };
    const fit = (kind: Kind, x0: number, x1: number, bottom: number, chunk: Chunk) => {
      const rect = sized(kind, x0, x1, bottom, chunk.h);
      if (kind !== "signature" && kind !== "initials") return rect;
      const limit = Math.max(0.027, roomAbove(x0, x1, bottom, chunk) + 0.004);
      if (rect.h <= limit) return rect;
      return { ...rect, y: rect.y + (rect.h - limit), h: limit };
    };

    for (const chunk of chunks) {
      const lineChunks = lines[chunk.line] ?? [];
      const indexInLine = lineChunks.indexOf(chunk);
      const left = indexInLine > 0 ? lineChunks[indexInLine - 1] : null;
      const bottom = chunk.y + chunk.h;

      // 3. Placeholder tokens: [Client Name], {{file_number}}
      for (const m of chunk.text.matchAll(/\[([A-Za-z][A-Za-z0-9 _/'#.-]{1,40})\]|\{\{\s*([^{}]{1,40}?)\s*\}\}/g)) {
        const raw = (m[1] ?? m[2] ?? "").replace(/_/g, " ").trim();
        if (!raw || NOT_A_TOKEN.test(raw)) continue;
        const known = TOKEN_VARIABLES.find(([re]) => re.test(raw))?.[1];
        const start = m.index ?? 0;
        const end = start + m[0].length;
        const x0 = chunk.chars[start]?.x0 ?? chunk.x0;
        const x1 = chunk.chars[end - 1]?.x1 ?? chunk.x1;
        proposals.push({
          id: "",
          type: "text",
          page: page.page,
          ...clampRect({ x: x0 - 0.002, y: chunk.y - chunk.h * 0.2, w: x1 - x0 + 0.004, h: chunk.h * 1.45 }),
          assignee: AUTO,
          required: true,
          variable: known ?? customVariable(raw),
          mask: true,
          fontSize: Math.max(6, Math.min(18, Math.round(chunk.h * page.height * 0.92 * 2) / 2)),
          label: titleCase(raw),
          confidence: 0.7,
          source: "detected",
        });
      }

      // 2. Blank lines.
      const blanks = [...chunk.text.matchAll(/_{3,}|\.{8,}|…{3,}/g)];
      blanks.forEach((m, bi) => {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        const x0 = chunk.chars[start]?.x0 ?? chunk.x0;
        const x1 = chunk.chars[end - 1]?.x1 ?? chunk.x1;
        if (x1 - x0 < 0.025) return;
        const prevEnd = bi > 0 ? (blanks[bi - 1].index ?? 0) + blanks[bi - 1][0].length : 0;
        const nextStart = bi + 1 < blanks.length ? blanks[bi + 1].index ?? chunk.text.length : chunk.text.length;
        const before = chunk.text.slice(prevEnd, start).trim();
        const after = chunk.text.slice(end, nextStart).trim();

        // Text printed under the blank, within about two lines.
        let below = "";
        let belowChunk: Chunk | null = null;
        for (const other of chunks) {
          if (other.line <= chunk.line || other.y - bottom > chunk.h * 2.4 || other.y < bottom - chunk.h * 0.3) continue;
          if (other.x0 >= x1 || other.x1 <= x0) continue;
          const text = other.chars
            .filter((ch) => (ch.x0 + ch.x1) / 2 >= x0 - 0.012 && (ch.x0 + ch.x1) / 2 <= x1 + 0.012)
            .map((ch) => ch.c)
            .join("")
            .trim();
          if (text && (!belowChunk || other.y < belowChunk.y)) {
            below = text;
            belowChunk = other;
          }
        }

        let kind: Kind = "other";
        let label = "";
        let confidence = 0.5;
        const beforeLabel = before.endsWith(":") ? tailWords(before.split(/[.;]\s/).pop() ?? before, 6) : tailWords(before, 2);
        const leftLabel = !before && left && bi === 0 ? tailWords(left.text.replace(/_+/g, " "), 5) : "";
        const candidates: [string, number, boolean][] = [
          [beforeLabel, 0.9, before.endsWith(":")],
          [leftLabel, 0.8, leftLabel.trim().endsWith(":")],
          [below.split(/\s+/).length <= 6 ? below : "", 0.8, true],
          [headWords(after.replace(/^[\s(]+/, ""), 3), 0.7, false],
        ];
        for (const [text, conf, strong] of candidates) {
          if (!text) continue;
          const k = classify(text);
          if (k !== "other" || (strong && text.replace(/[^A-Za-z]/g, "").length > 1 && text.split(/\s+/).length <= 6 && text === beforeLabel)) {
            kind = k === "other" ? "info" : k;
            label = text;
            confidence = conf;
            if (text === below && belowChunk) used.add(belowChunk.id);
            break;
          }
        }

        const context = `${label} ${before.endsWith(":") ? before : ""}`;
        let role = roleOf(context, firmName);

        // "between ______ (the "Client")": the blank is that party's name.
        const party = after.match(/^[\s(]*(?:the\s+|hereinafter\s+|hereafter\s+)*["“'‘]?\s*([A-Za-z ]{3,24})/);
        if (kind === "other" && party && /^[\s(]/.test(after)) {
          const r = roleOf(party[1], firmName);
          if (r === "client") {
            proposals.push(make(page.page, sized("other", x0, x1, bottom, chunk.h), "other", "firm", "", 0.75, { variable: "client_name", label: "Client name" }));
            return;
          }
          if (r === "firm") {
            proposals.push(make(page.page, sized("other", x0, x1, bottom, chunk.h), "firm_name", "firm", "", 0.75, { label: "Firm name" }));
            return;
          }
        }

        if (!role && kind !== "other") role = blockRole(x0, x1, chunk.y);
        if (kind === "other") {
          label = tailWords(before, 4) || headWords(after, 3) || "";
          confidence = 0.4;
        }
        proposals.push(make(page.page, fit(kind, x0, x1, bottom, chunk), kind, role, label, confidence));
      });
    }

    // 4. Labels beside or under a drawn rule (no underscore characters in the text layer).
    for (const chunk of chunks) {
      if (used.has(chunk.id) || /_{3,}|\.{8,}/.test(chunk.text)) continue;
      const text = chunk.text.trim();
      const words = text.split(/\s+/);
      const lineChunks = lines[chunk.line] ?? [];
      const next = lineChunks[lineChunks.indexOf(chunk) + 1];

      if (text.endsWith(":") && words.length <= 6) {
        const kind = classify(tailWords(text, 4));
        if (kind === "other" || kind === "info" || kind === "email" || kind === "firm_name") continue;
        if (next && /_{3,}/.test(next.text)) continue;
        const x0 = chunk.x1 + 0.012;
        const x1 = next ? next.x0 - 0.012 : Math.min(0.94, x0 + (kind === "date" ? 0.16 : 0.3));
        if (x1 - x0 < 0.07) continue;
        const role = roleOf(text, firmName) ?? blockRole(chunk.x0, x1, chunk.y);
        proposals.push(make(page.page, fit(kind, x0, x1, chunk.y + chunk.h, chunk), kind, role, text, 0.5));
        continue;
      }

      if (words.length <= 4 && /^[A-Za-z][A-Za-z' /-]*$/.test(text) && !NOT_A_LABEL.test(text)) {
        const kind = classify(text);
        if (kind !== "signature" && kind !== "date" && kind !== "name") continue;
        if (kind === "signature" && !/\bsignature\b/i.test(text)) continue;
        // Require clear space above: that is where the rule is.
        let nearestAbove = Infinity;
        for (const other of chunks) {
          if (other.id === chunk.id || other.y + other.h > chunk.y + 0.002) continue;
          if (other.x0 >= chunk.x1 + 0.05 || other.x1 <= chunk.x0) continue;
          nearestAbove = Math.min(nearestAbove, chunk.y - (other.y + other.h));
        }
        if (nearestAbove < chunk.h * 1.7) continue;
        const width = Math.max(chunk.x1 - chunk.x0, kind === "date" ? 0.14 : 0.26);
        const role = roleOf(text, firmName) ?? blockRole(chunk.x0, chunk.x0 + width, chunk.y);
        proposals.push(make(page.page, sized(kind, chunk.x0, chunk.x0 + width, chunk.y - 0.004, chunk.h), kind, role, text, 0.45));
      }
    }
  }

  // 1. Real form widgets win over anything inferred from text.
  for (const w of widgets) {
    const words = w.name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.\-[\]0-9]+/g, " ");
    const role = roleOf(words, firmName);
    if (w.kind === "checkbox") {
      proposals.push({
        id: "",
        type: "checkbox",
        page: w.page,
        ...clampRect({ x: w.x, y: w.y, w: w.w, h: w.h }),
        assignee: role === "firm" ? AUTO : role === "client2" ? "client2" : "client",
        required: false,
        label: titleCase(words).slice(0, 60) || undefined,
        confidence: 0.95,
        source: "form",
      });
      continue;
    }
    const kind = w.kind === "signature" ? "signature" : classify(words);
    const rect = { x: w.x, y: w.y, w: w.w, h: w.h };
    proposals.push({ ...make(w.page, rect, kind === "other" ? "info" : kind, role, words, 0.95), source: "form" });
  }

  // Resolve overlaps in favour of the more confident proposal.
  proposals.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const accepted: Field[] = [];
  for (const p of proposals) {
    if (accepted.some((a) => a.page === p.page && overlapRatio(a, p) > 0.35)) continue;
    accepted.push(p);
  }
  accepted.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  accepted.forEach((f, i) => (f.id = `d${i + 1}`));

  const usedVariables = new Set(accepted.map((f) => f.variable).filter(Boolean));
  const roles: Role[] = [...DEFAULT_ROLES];
  if (accepted.some((f) => f.assignee === "client2")) roles.push({ key: "client2", label: "Co-signer" });

  return {
    fields: accepted,
    roles,
    variables: [...variables.values()].filter((v) => usedVariables.has(v.key)),
    hasText,
  };
}
