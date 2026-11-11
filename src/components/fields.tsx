"use client";

import { Check } from "lucide-react";
import type { CSSProperties } from "react";
import { charWidth } from "@/lib/detect";
import type { Field, FieldType, FieldValue, PageSize, SignatureValue } from "@/lib/types";
import { SignatureView } from "./signature";

export const TYPE_LABEL: Record<FieldType, string> = {
  signature: "Signature",
  initials: "Initials",
  date: "Date",
  name: "Full name",
  text: "Text",
  checkbox: "Checkbox",
};

/** Position a field over its page. The page wrapper is a size container, so percentages suffice. */
export function fieldBox(f: Pick<Field, "x" | "y" | "w" | "h">): CSSProperties {
  return { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` };
}

/** Same rule the PDF stamper uses, so the preview matches the signed document. */
export function fieldFontPt(f: Pick<Field, "h" | "fontSize">, page: PageSize) {
  return f.fontSize ?? Math.min(11, Math.max(6.5, f.h * page.height * 0.62));
}

/** Estimated width of text in points, using the same advance table as field detection. */
function textWidthPt(text: string, size: number) {
  let units = 0;
  for (const c of text) units += charWidth(c);
  return (units / 1000) * size;
}

/**
 * Font size for a value: the field's size, reduced until the text fits its box. The PDF
 * stamper applies the same shrink-to-fit, so a long date looks the same before and after.
 */
export function fitFontPt(f: Pick<Field, "w" | "h" | "fontSize">, page: PageSize, text = "") {
  let size = fieldFontPt(f, page);
  const room = f.w * page.width - 3;
  while (size > 5 && textWidthPt(text, size) > room) size -= 0.25;
  return size;
}

export function fieldTextStyle(f: Pick<Field, "w" | "h" | "fontSize">, page: PageSize, text = ""): CSSProperties {
  return { fontSize: `${(fitFontPt(f, page, text) / page.height) * 100}cqh`, paddingLeft: `${(1.5 / page.width) * 100}cqw` };
}

export function isSignatureValue(v: unknown): v is SignatureValue {
  return typeof v === "object" && v !== null && "kind" in v;
}

/** A filled value drawn the way it will appear on the signed PDF. */
export function FieldValueView({ field, value, page }: { field: Field; value: FieldValue | undefined; page: PageSize }) {
  if (value === undefined || value === "" || value === false) return null;
  if (isSignatureValue(value)) {
    return (
      <div className="size-full p-[0.2cqh]">
        <SignatureView value={value} />
      </div>
    );
  }
  if (value === true) {
    return (
      <div className="grid size-full place-items-center text-[#121c33]">
        <Check className="size-[85%]" strokeWidth={3} />
      </div>
    );
  }
  return (
    <div className="field-text flex size-full items-center overflow-hidden" style={{ ...fieldTextStyle(field, page, String(value)), background: field.mask ? "#fff" : undefined }}>
      {String(value)}
    </div>
  );
}
