/**
 * Live-update indicator.
 *
 * When live updates stop, the screen must say so. A quiet kitchen queue and a
 * dropped socket look identical otherwise, and staff act on figures they
 * believe are current.
 */
import { useEffect, useState } from "react";
import { Radio, RefreshCw, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRealtimeStatus } from "@/lib/realtime-scope";

/** Compact age label: the badge sits in the header, so it stays tiny. */
function ago(from: number | null, now: number): string {
  if (!from) return "—";
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

export function LiveStatus({ className }: { className?: string }) {
  const { connection, lastUpdateAt, attempts } = useRealtimeStatus();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  if (connection === "off") return null;

  const reconnecting = connection === "reconnecting";
  const connecting = connection === "connecting";
  const Icon = reconnecting ? WifiOff : connecting ? RefreshCw : Radio;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[0.65rem] leading-none",
        reconnecting
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-border bg-muted/40 text-muted-foreground",
        className,
      )}
      title={
        reconnecting
          ? `Live updates have stopped${attempts > 1 ? ` (attempt ${attempts})` : ""}. The screen will refresh itself once the connection returns. Last updated ${ago(lastUpdateAt, now)}.`
          : connecting
            ? "Connecting live updates…"
            : "This screen updates itself as work is committed."
      }
    >
      <Icon className={cn("size-3", connecting && "animate-spin")} />
      {reconnecting ? `Offline · ${ago(lastUpdateAt, now)}` : connecting ? "…" : `Live · ${ago(lastUpdateAt, now)}`}
    </span>
  );
}
