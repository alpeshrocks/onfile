import clsx from "clsx";

/** A file folder with its tab, and a check where the label would be. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={clsx("size-7", className)} aria-hidden>
      <path d="M3 9a3 3 0 0 1 3-3h7.2a3 3 0 0 1 2.2 1l1.5 1.6a3 3 0 0 0 2.2 1H26a3 3 0 0 1 3 3V24a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9Z" fill="#1b3fd8" />
      <path d="M19.5 5.2h6.3a1.6 1.6 0 0 1 1.6 1.6v1.4h-5.9l-2-3Z" fill="#ffd23f" />
      <path d="M10.5 18.4l3.6 3.6 7.6-8" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-2", className)}>
      <LogoMark />
      <span className="display text-[21px] text-ink">Onfile</span>
    </span>
  );
}
