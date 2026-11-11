import type { SignatureValue } from "./types";

/**
 * Drawn signatures are stored as vector strokes, not bitmaps. One path builder feeds both
 * the on-screen SVG and the PDF, so what the signer saw is what lands on the page, and it
 * stays sharp at any zoom or print size.
 */
export function strokesToPath(strokes: number[][]): string {
  const parts: string[] = [];
  for (const s of strokes) {
    const n = Math.floor(s.length / 2);
    if (n === 0) continue;
    const f = (v: number) => (Math.round(v * 100) / 100).toString();
    if (n === 1) {
      // A dot: draw a tiny segment so round caps render it.
      parts.push(`M${f(s[0])} ${f(s[1])}L${f(s[0] + 0.1)} ${f(s[1] + 0.1)}`);
      continue;
    }
    parts.push(`M${f(s[0])} ${f(s[1])}`);
    // Quadratic curves through midpoints give a smooth pen line from raw pointer samples.
    for (let i = 1; i < n - 1; i++) {
      const mx = (s[i * 2] + s[i * 2 + 2]) / 2;
      const my = (s[i * 2 + 1] + s[i * 2 + 3]) / 2;
      parts.push(`Q${f(s[i * 2])} ${f(s[i * 2 + 1])} ${f(mx)} ${f(my)}`);
    }
    parts.push(`L${f(s[(n - 1) * 2])} ${f(s[(n - 1) * 2 + 1])}`);
  }
  return parts.join("");
}

/** Crop strokes to their bounding box (with padding) so the signature fills its field. */
export function normalizeStrokes(strokes: number[][], pad = 4): { strokes: number[][]; width: number; height: number } {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const s of strokes) {
    for (let i = 0; i + 1 < s.length; i += 2) {
      minX = Math.min(minX, s[i]);
      maxX = Math.max(maxX, s[i]);
      minY = Math.min(minY, s[i + 1]);
      maxY = Math.max(maxY, s[i + 1]);
    }
  }
  if (!isFinite(minX)) return { strokes: [], width: 1, height: 1 };
  const width = Math.max(1, maxX - minX + pad * 2);
  const height = Math.max(1, maxY - minY + pad * 2);
  const r = (v: number) => Math.round(v * 10) / 10;
  return {
    strokes: strokes.map((s) => s.map((v, i) => r(i % 2 === 0 ? v - minX + pad : v - minY + pad))),
    width: r(width),
    height: r(height),
  };
}

/** Total ink length. Used to reject accidental taps as signatures. */
export function inkLength(strokes: number[][]): number {
  let total = 0;
  for (const s of strokes) {
    for (let i = 2; i + 1 < s.length; i += 2) total += Math.hypot(s[i] - s[i - 2], s[i + 1] - s[i - 1]);
  }
  return total;
}

/**
 * Deterministic handwriting-like strokes for a name. Used only for seeded demo data,
 * where no human is present to draw.
 */
export function syntheticSignature(name: string): SignatureValue {
  let seed = 0;
  for (const c of name) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const strokes: number[][] = [];
  const words = name.split(/\s+/).filter(Boolean).slice(0, 2);
  let cursor = 6;
  for (const word of words) {
    const stroke: number[] = [];
    const len = Math.max(3, Math.min(9, word.length));
    const amp = 10 + rand() * 6;
    // A tall opening loop for the capital, then a decaying run of humps.
    for (let t = 0; t <= 1; t += 0.08) {
      stroke.push(cursor + 10 * Math.sin(t * Math.PI * 2) + t * 8, 30 - 24 * Math.sin(t * Math.PI));
    }
    for (let i = 0; i < len * 6; i++) {
      const t = i / 6;
      const decay = 1 - (t / len) * 0.55;
      stroke.push(cursor + 16 + t * 11 + rand() * 0.8, 30 - Math.abs(Math.sin(t * Math.PI + rand() * 0.2)) * amp * decay);
    }
    cursor += 16 + len * 11 + 14;
    strokes.push(stroke);
  }
  // Underline flourish.
  strokes.push([8, 38, cursor * 0.5, 41 + rand() * 2, cursor - 6, 36]);
  const n = normalizeStrokes(strokes);
  return { kind: "drawn", ...n };
}
