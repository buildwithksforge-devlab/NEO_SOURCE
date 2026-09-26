import { useEffect, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import { useDataRefresh } from "@/components/common/PullToRefresh";

/**
 * The keyboard and desktop equivalent of the swipe-down gesture.
 *
 * Same read-only refresh: it re-runs the page's loaders and refetches the live
 * queries on screen. It never submits anything, and a second press while one
 * refresh is running is ignored.
 */
export function RefreshButton({
  className,
  label = "Refresh",
}: {
  className?: string;
  label?: string;
}) {
  const runRefresh = useDataRefresh();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const busyRef = useRef(false);

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(""), 2_000);
    return () => clearTimeout(t);
  }, [status]);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        try {
          const outcome = await runRefresh();
          setStatus(
            outcome === "ok"
              ? "Updated"
              : outcome === "offline"
                ? "You are offline"
                : "Unable to refresh",
          );
        } finally {
          busyRef.current = false;
          setBusy(false);
        }
      }}
      aria-label={label}
      title={label}
      className={
        className ??
        "inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
      }
    >
      <RotateCw className={`size-4 ${busy ? "animate-spin" : ""}`} aria-hidden />
      <span className="sr-only" role="status" aria-live="polite">
        {busy ? "Refreshing" : status}
      </span>
    </button>
  );
}
