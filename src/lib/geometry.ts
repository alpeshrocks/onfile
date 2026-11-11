/**
 * Coordinate mapping between "the page as a person sees it" and PDF user space.
 *
 * Fields are stored normalized to the displayed page (rotation applied, origin top left),
 * which is exactly what pdf.js renders. PDF user space has its origin bottom left, may be
 * offset by a crop box and may carry a /Rotate of 0, 90, 180 or 270. Getting this wrong puts
 * a signature in the wrong place on scanned or landscape agreements, so it lives in one
 * tested function instead of being re-derived at each call site.
 */

export interface PageBox {
  /** Crop box in user space. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** /Rotate, clockwise degrees. */
  rotation: number;
}

export function normalizeRotation(deg: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

/** Size of the page as displayed, in points. */
export function displayedSize(box: PageBox): { width: number; height: number } {
  const r = normalizeRotation(box.rotation);
  return r === 90 || r === 270 ? { width: box.height, height: box.width } : { width: box.width, height: box.height };
}

/** Map a point in displayed space (points, origin top left) to PDF user space. */
export function toUserSpace(box: PageBox, vx: number, vy: number): { x: number; y: number } {
  switch (normalizeRotation(box.rotation)) {
    case 0:
      return { x: box.x + vx, y: box.y + box.height - vy };
    case 90:
      return { x: box.x + vy, y: box.y + vx };
    case 180:
      return { x: box.x + box.width - vx, y: box.y + vy };
    case 270:
      return { x: box.x + box.width - vy, y: box.y + box.height - vx };
  }
}

/**
 * Convert a normalized field rectangle into displayed points.
 */
export function fieldRect(box: PageBox, f: { x: number; y: number; w: number; h: number }) {
  const size = displayedSize(box);
  return { x: f.x * size.width, y: f.y * size.height, w: f.w * size.width, h: f.h * size.height };
}

export function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

/** Keep a normalized rectangle fully on the page. */
export function clampRect<T extends { x: number; y: number; w: number; h: number }>(r: T): T {
  const w = clamp(r.w, 0.01, 1);
  const h = clamp(r.h, 0.006, 1);
  return { ...r, w, h, x: clamp(r.x, 0, 1 - w), y: clamp(r.y, 0, 1 - h) };
}

export function overlapRatio(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller > 0 ? inter / smaller : 0;
}
