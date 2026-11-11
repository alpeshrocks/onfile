"use client";

import clsx from "clsx";
import { Check, Copy, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { FILE_STATUS_LABEL, type FileStatus } from "@/lib/types";
import { buttonClass, type Size, type Variant } from "./button-class";

export function Button({
  variant = "primary",
  size = "md",
  loading,
  className,
  children,
  ...props
}: ComponentProps<"button"> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button type="button" {...props} disabled={props.disabled || loading} className={buttonClass(variant, size, className)}>
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function LinkButton({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link {...props} className={buttonClass(variant, size, className)} />;
}

const INPUT =
  "block w-full rounded-md border border-line bg-surface px-3 text-[15px] text-ink placeholder:text-faint transition-[border-color,box-shadow] duration-150 hover:border-faint/70 focus:border-blue focus:outline-none focus:ring-3 focus:ring-blue/15 disabled:bg-paper disabled:text-muted";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input {...props} className={clsx(INPUT, "h-10", className)} />;
}
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea {...props} className={clsx(INPUT, "min-h-24 py-2 leading-relaxed", className)} />;
}
export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select {...props} className={clsx(INPUT, "h-10 pr-8", className)} />;
}

export function Field({
  label,
  hint,
  error,
  optional,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={clsx("block", className)}>
      <span className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px] font-semibold text-ink-2">
        {label}
        {optional && <span className="font-normal text-faint">Optional</span>}
      </span>
      {children}
      {error ? <span className="mt-1.5 block text-[13px] text-red">{error}</span> : hint ? <span className="mt-1.5 block text-[13px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={clsx("rounded-xl border border-line bg-surface", className)} />;
}

const STATUS_STYLE: Record<FileStatus, string> = {
  draft: "bg-line-2 text-ink-2",
  awaiting_signature: "bg-flag-50 text-flag-ink",
  signed: "bg-green-50 text-green",
  declined: "bg-red-50 text-red",
  voided: "bg-line-2 text-muted",
  expired: "bg-amber-50 text-amber",
};
const STATUS_DOT: Record<FileStatus, string> = {
  draft: "bg-faint",
  awaiting_signature: "bg-flag-ink/70",
  signed: "bg-green",
  declined: "bg-red",
  voided: "bg-faint",
  expired: "bg-amber",
};

export function StatusPill({ status, label, className }: { status: FileStatus; label?: string; className?: string }) {
  return (
    <span className={clsx("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold whitespace-nowrap", STATUS_STYLE[status], className)}>
      <span className={clsx("size-1.5 rounded-full", STATUS_DOT[status])} aria-hidden />
      {label ?? FILE_STATUS_LABEL[status]}
    </span>
  );
}

export function Badge({ tone = "neutral", children, className }: { tone?: "neutral" | "blue" | "green" | "amber" | "red" | "flag" | "teal"; children: ReactNode; className?: string }) {
  const tones = {
    neutral: "bg-line-2 text-ink-2",
    blue: "bg-blue-50 text-blue",
    green: "bg-green-50 text-green",
    amber: "bg-amber-50 text-amber",
    red: "bg-red-50 text-red",
    flag: "bg-flag-50 text-flag-ink",
    teal: "bg-teal-50 text-teal",
  };
  return <span className={clsx("inline-flex h-5.5 items-center rounded-full px-2 text-[11.5px] font-semibold whitespace-nowrap", tones[tone], className)}>{children}</span>;
}

/** Modal built on the native dialog element: focus trap, Escape and inert background come free. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // The native close event also fires when we close the dialog ourselves because the
  // `open` prop changed. Only a close the person initiated (Escape, backdrop) is reported.
  const wantOpen = useRef(open);
  wantOpen.current = open;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={() => {
        if (wantOpen.current) onClose();
      }}
      onCancel={(e) => {
        if (!dismissible) e.preventDefault();
      }}
      onClick={(e) => {
        if (dismissible && e.target === ref.current) onClose();
      }}
      className={clsx(
        "w-[calc(100vw-24px)] rounded-2xl bg-surface p-0 text-ink shadow-pop outline-none",
        size === "sm" && "max-w-md",
        size === "md" && "max-w-xl",
        size === "lg" && "max-w-3xl",
      )}
    >
      {open && (
        <div className="flex max-h-[calc(100dvh-32px)] flex-col">
          <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-1">
            <div>
              <h2 className="display text-[22px]">{title}</h2>
              {description && <p className="mt-1.5 text-sm text-muted">{description}</p>}
            </div>
            {dismissible && (
              <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 grid size-9 shrink-0 place-items-center rounded-md text-muted hover:bg-line-2 hover:text-ink">
                <X className="size-4.5" />
              </button>
            )}
          </header>
          <div className="scroll-thin overflow-y-auto px-6 py-4">{children}</div>
          {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line-2 px-6 py-4">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export function CopyButton({ value, label = "Copy", size = "sm", variant = "secondary", className }: { value: string; label?: string; size?: Size; variant?: Variant; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          const el = document.createElement("textarea");
          el.value = value;
          document.body.appendChild(el);
          el.select();
          document.execCommand("copy");
          el.remove();
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      {copied ? <Check className="size-3.5 text-green" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx("animate-spin text-muted", className ?? "size-5")} aria-label="Loading" />;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {icon && <div className="mb-4 grid size-12 place-items-center rounded-full bg-blue-50 text-blue">{icon}</div>}
      <h3 className="display text-xl">{title}</h3>
      {children && <p className="mt-2 max-w-sm text-sm text-muted">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="display text-[32px] sm:text-[36px]">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-[15px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div role="tablist" className={clsx("inline-flex rounded-lg bg-line-2 p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "h-8 rounded-md px-3 text-[13px] font-semibold transition-colors",
            value === o.value ? "bg-surface text-ink shadow-[0_1px_2px_rgb(14_26_43/0.12)]" : "text-muted hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
