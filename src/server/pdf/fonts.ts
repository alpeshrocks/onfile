import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFFont, StandardFonts } from "pdf-lib";

export type Face = "sans" | "sansBold" | "serif" | "serifBold" | "serifItalic" | "mono";

const STANDARD: Record<Face, StandardFonts> = {
  sans: StandardFonts.Helvetica,
  sansBold: StandardFonts.HelveticaBold,
  serif: StandardFonts.TimesRoman,
  serifBold: StandardFonts.TimesRomanBold,
  serifItalic: StandardFonts.TimesRomanItalic,
  mono: StandardFonts.Courier,
};

const UNICODE_FILES: Record<Face, string> = {
  sans: "DejaVuSans.ttf",
  sansBold: "DejaVuSans-Bold.ttf",
  serif: "DejaVuSerif.ttf",
  serifBold: "DejaVuSerif-Bold.ttf",
  serifItalic: "DejaVuSerif-Italic.ttf",
  mono: "DejaVuSans.ttf",
};

/** Code points no PDF font can draw: C0/C1 controls, zero-width marks, line separators, BOM. */
function undrawable(cp: number) {
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0x2028 || cp === 0x2029 || cp === 0xfeff;
}

/** Strip characters no PDF font can draw (control characters, stray newlines). */
export function cleanText(text: string) {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0xa0) out += " ";
    else if (!undrawable(cp)) out += ch;
  }
  return out;
}

function encodable(font: PDFFont, text: string) {
  try {
    font.encodeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Font selection per string.
 *
 * The 14 standard PDF fonts cost nothing to embed but only cover Windows-1252. A client
 * named "Zoë" works; "Łukasz" or "Αλέξης" would make pdf-lib throw. So: use the standard
 * face when it can encode the text, otherwise embed a bundled Unicode face (DejaVu), and
 * as a last resort replace only the unsupported characters. A signature can never fail
 * because of someone's name.
 */
export class Fonts {
  private standard = new Map<Face, PDFFont>();
  private unicode = new Map<Face, { font: PDFFont; set: Set<number> } | null>();
  private registered = false;

  constructor(private doc: PDFDocument) {}

  async std(face: Face) {
    let f = this.standard.get(face);
    if (!f) {
      f = await this.doc.embedFont(STANDARD[face]);
      this.standard.set(face, f);
    }
    return f;
  }

  async uni(face: Face) {
    if (this.unicode.has(face)) return this.unicode.get(face)!;
    let entry: { font: PDFFont; set: Set<number> } | null = null;
    try {
      const bytes = await readFile(path.join(process.cwd(), "assets", "fonts", UNICODE_FILES[face]));
      if (!this.registered) {
        this.doc.registerFontkit(fontkit);
        this.registered = true;
      }
      const font = await this.doc.embedFont(bytes, { subset: false });
      entry = { font, set: new Set(font.getCharacterSet()) };
    } catch (err) {
      console.warn("[onfile] Unicode font unavailable, falling back to standard fonts:", err);
    }
    this.unicode.set(face, entry);
    return entry;
  }

  /** Returns a font that can draw the text, and the text adjusted to what that font supports. */
  async pick(face: Face, raw: string, forceUnicode = false): Promise<{ font: PDFFont; text: string }> {
    const text = cleanText(raw);
    const std = await this.std(face);
    if (!forceUnicode && encodable(std, text)) return { font: std, text };
    const uni = await this.uni(face);
    if (uni) {
      const safe = [...text].map((c) => (uni.set.has(c.codePointAt(0)!) ? c : "?")).join("");
      return { font: uni.font, text: safe };
    }
    const safe = [...text].map((c) => (encodable(std, c) ? c : "?")).join("");
    return { font: std, text: safe };
  }

  /** True when every string can be drawn with standard fonts. */
  async allStandard(face: Face, texts: string[]) {
    const std = await this.std(face);
    return texts.every((t) => encodable(std, cleanText(t)));
  }
}
