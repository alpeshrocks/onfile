import clsx from "clsx";

/**
 * Button styling as a plain function in a plain module, so server components can style
 * links as buttons without importing from a client module.
 */
export type Variant = "primary" | "secondary" | "ghost" | "danger" | "flag";
export type Size = "sm" | "md" | "lg";

const BUTTON_BASE =
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-semibold whitespace-nowrap select-none transition-[background-color,border-color,color,transform,filter] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-blue text-white hover:bg-blue-dark",
  secondary: "border border-line bg-surface text-ink hover:border-faint/60 hover:bg-paper",
  ghost: "text-ink-2 hover:bg-line-2",
  danger: "bg-red text-white hover:brightness-95",
  flag: "bg-flag text-flag-ink hover:brightness-95",
};
const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-[15px]",
};

export function buttonClass(variant: Variant = "primary", size: Size = "md", extra?: string) {
  return clsx(BUTTON_BASE, VARIANTS[variant], SIZES[size], extra);
}

