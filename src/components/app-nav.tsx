"use client";

import clsx from "clsx";
import { Code2, FileSignature, FolderOpen, LayoutDashboard, LogOut, Mail, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { logoutAction } from "@/app/actions";
import { initials } from "@/lib/format";
import { Logo } from "./logo";

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/files", label: "Files", icon: FolderOpen },
  { href: "/agreements", label: "Agreements", icon: FileSignature },
  { href: "/outbox", label: "Outbox", icon: Mail },
  { href: "/developers", label: "Connect", icon: Code2 },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppNav({ workspace, user, awaiting }: { workspace: string; user: string; awaiting: number }) {
  const pathname = usePathname();
  const router = useRouter();
  const signOut = async () => {
    await logoutAction();
    router.push("/");
    router.refresh();
  };

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 flex w-[232px] flex-col border-r border-line bg-surface max-lg:hidden">
        <Link href="/dashboard" className="flex h-16 items-center px-5">
          <Logo />
        </Link>
        <nav className="flex-1 space-y-0.5 px-3 pt-2" aria-label="Main">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={clsx(
                  "flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-semibold transition-colors",
                  active ? "bg-blue-50 text-blue" : "text-ink-2 hover:bg-line-2 hover:text-ink",
                )}
              >
                <item.icon className="size-[18px]" />
                <span className="flex-1">{item.label}</span>
                {item.href === "/files" && awaiting > 0 && <span className="tabular rounded-full bg-flag px-1.5 text-[11px] leading-5 font-bold text-flag-ink">{awaiting}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-line-2 p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ink text-xs font-bold text-white">{initials(user)}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{workspace}</p>
              <p className="truncate text-xs text-muted">{user}</p>
            </div>
            <button type="button" onClick={signOut} aria-label="Sign out" title="Sign out" className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-line-2 hover:text-ink">
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 border-b border-line bg-surface lg:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <Link href="/dashboard">
            <Logo />
          </Link>
          <button type="button" onClick={signOut} className="text-sm font-semibold text-muted">
            Sign out
          </button>
        </div>
        <nav className="scroll-thin flex gap-1 overflow-x-auto px-3 pb-2" aria-label="Main">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={clsx("inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] font-semibold", active ? "bg-blue-50 text-blue" : "text-ink-2")}
              >
                <item.icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
    </>
  );
}
