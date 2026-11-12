"use client";

import { useEffect, useState } from "react";
import { formatDate, formatDateTime, timeAgo } from "@/lib/format";

const FORMAT = { ago: timeAgo, datetime: formatDateTime, date: formatDate } as const;

/**
 * A timestamp in the viewer's own time zone. The server cannot know that zone, so it
 * renders its best guess and the browser corrects it on mount; the mismatch is expected
 * and suppressed here, in one place, instead of leaking hydration warnings everywhere.
 *
 * The key matters. With the warning suppressed React keeps the server's text in the page
 * while believing it rendered the browser's, so setting state to that same browser text
 * changes nothing and the server's zone stays on screen. Changing the key on mount makes
 * React replace the element, which puts the viewer's time in the page.
 */
export function Time({ value, mode = "datetime" }: { value: Date | string | null | undefined; mode?: keyof typeof FORMAT }) {
  const iso = value ? (typeof value === "string" ? value : value.toISOString()) : "";
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!iso) return;
    const update = () => setText(FORMAT[mode](iso));
    update();
    if (mode !== "ago") return;
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, [iso, mode]);
  if (!iso) return null;
  return (
    <time key={text === null ? "server" : "viewer"} dateTime={iso} title={mode === "ago" ? formatDateTime(iso) : undefined} suppressHydrationWarning>
      {text ?? FORMAT[mode](iso)}
    </time>
  );
}
