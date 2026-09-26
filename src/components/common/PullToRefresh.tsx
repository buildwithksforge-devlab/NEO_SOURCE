import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { Loader2, ArrowDown, Check, CloudOff, RotateCcw } from "lucide-react";

/** How far the finger must travel before the release actually refreshes. */
const TRIGGER = 72;
/** The pull never stretches further than this, however hard you drag. */
const MAX = 104;
/** Beyond the first pixels the sheet follows the finger at half speed. */
const RESISTANCE = 0.55;
/** A gesture wandering sideways belongs to the browser or a carousel. */
const HORIZONTAL_SLOP = 12;
/** A refresh that never answers still has to clear the indicator. */
const TIMEOUT_MS = 12_000;
/** How long the result chip stays before it fades away. */
const RESULT_MS = 1_800;

type Result = "idle" | "ok" | "offline" | "error";

/**
 * Data refresh, never a document reload.
 *
 * Re-runs the route loaders and refetches the live queries on screen, so the
 * session, the active property and context, the cart, booking drafts and any
 * unsent form input all survive untouched. It can neither submit nor repeat a
 * mutation: it only reads.
 */
export function useDataRefresh() {
  const queryClient = useQueryClient();

  return useCallback(async (): Promise<Result> => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
    try {
      await Promise.race([
        queryClient.refetchQueries({ type: "active" }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("refresh-timeout")), TIMEOUT_MS),
        ),
      ]);
      return "ok";
    } catch {
      return typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "error";
    }
  }, [queryClient]);
}

/** True when the gesture starts inside something that owns its own scrolling. */
function ownedByNestedScroller(target: EventTarget | null, host: HTMLElement) {
  let node = target instanceof Element ? target : null;
  while (node && node !== host) {
    // A dialog, sheet, drawer or popover always keeps the gesture.
    if (node.hasAttribute("data-no-pull-refresh")) return true;
    const role = node.getAttribute("role");
    if (role === "dialog" || role === "alertdialog") return true;
    if (node instanceof HTMLElement) {
      if (node.draggable || node.getAttribute("aria-grabbed") === "true") return true;
      const style = window.getComputedStyle(node);
      const scrolls = /(auto|scroll|overlay)/.test(style.overflowY);
      if (scrolls && node.scrollHeight > node.clientHeight && node.scrollTop > 0) return true;
    }
    node = node.parentElement;
  }
  return false;
}

/** True while a destructive or financial submission is in flight anywhere. */
function submissionBlocked() {
  if (typeof document === "undefined") return false;
  const body = document.body;
  // Radix locks the body whenever a modal, sheet or drawer is open.
  if (body.hasAttribute("data-scroll-locked")) return true;
  if (body.hasAttribute("data-neo-busy")) return true;
  if (document.querySelector("[data-no-pull-refresh-active]")) return true;
  return false;
}

/**
 * Swipe down slightly to refresh the page.
 *
 * Touch only — a mouse and a keyboard use the visible refresh control instead.
 * It arms exclusively at the very top of the primary scroll container, on a
 * clearly vertical gesture, with no modal, nested scroller, drag interaction
 * or in-flight mutation owning the moment. Releasing past the threshold
 * refetches the page's canonical data; releasing early springs back with
 * nothing fetched. Concurrent pulls are ignored while one is running.
 */
export function PullToRefresh({
  children,
  scrollTarget,
}: {
  children: React.ReactNode;
  /** Returns the element that scrolls. Defaults to the page itself. */
  scrollTarget?: () => HTMLElement | null;
}) {
  const runRefresh = useDataRefresh();
  const mutating = useIsMutating();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>("idle");
  const busyRef = useRef(false);
  const state = useRef({ startX: 0, startY: 0, active: false, decided: false });

  const refresh = useCallback(async () => {
    // One refresh at a time: a second pull while the first is running is a
    // no-op, so nothing is ever requested twice.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setResult("idle");
    let outcome: Result = "error";
    try {
      outcome = await runRefresh();
    } finally {
      // Always lands back at rest — success, failure or timeout alike.
      busyRef.current = false;
      setBusy(false);
      setPull(0);
      setResult(outcome);
    }
  }, [runRefresh]);

  useEffect(() => {
    if (result === "idle") return;
    const t = setTimeout(() => setResult("idle"), RESULT_MS);
    return () => clearTimeout(t);
  }, [result]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (typeof window === "undefined") return;
    // Pointer-coarse only: no pull-down on a trackpad or mouse.
    if (!window.matchMedia("(pointer: coarse)").matches) return;

    const topOf = () => {
      const el = scrollTarget?.();
      return el ? el.scrollTop : window.scrollY;
    };

    const onStart = (e: TouchEvent) => {
      if (busyRef.current || e.touches.length !== 1) return;
      if (topOf() > 0) return;
      if (mutating > 0 || submissionBlocked()) return;
      if (ownedByNestedScroller(e.target, host)) return;
      const touch = e.touches[0]!;
      state.current = { startX: touch.clientX, startY: touch.clientY, active: true, decided: false };
    };

    const onMove = (e: TouchEvent) => {
      if (!state.current.active || busyRef.current) return;
      const touch = e.touches[0]!;
      const dy = touch.clientY - state.current.startY;
      const dx = touch.clientX - state.current.startX;
      if (!state.current.decided) {
        // A sideways gesture is a browser back-swipe or a carousel: let it go.
        if (Math.abs(dx) > HORIZONTAL_SLOP && Math.abs(dx) > Math.abs(dy)) {
          state.current.active = false;
          setPull(0);
          return;
        }
        if (Math.abs(dy) < 6) return;
        state.current.decided = true;
      }
      if (dy <= 0 || topOf() > 0) {
        state.current.active = false;
        setPull(0);
        return;
      }
      const distance = Math.min(MAX, dy * RESISTANCE);
      if (distance > 6 && e.cancelable) e.preventDefault();
      setPull(distance);
    };

    const onEnd = () => {
      if (!state.current.active) return;
      state.current.active = false;
      setPull((current) => {
        if (current >= TRIGGER && !busyRef.current) {
          void refresh();
          return TRIGGER;
        }
        return 0;
      });
    };

    host.addEventListener("touchstart", onStart, { passive: true });
    host.addEventListener("touchmove", onMove, { passive: false });
    host.addEventListener("touchend", onEnd, { passive: true });
    host.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      host.removeEventListener("touchstart", onStart);
      host.removeEventListener("touchmove", onMove);
      host.removeEventListener("touchend", onEnd);
      host.removeEventListener("touchcancel", onEnd);
    };
  }, [mutating, refresh, scrollTarget]);

  // Someone who asked for less motion still gets the refresh, without the
  // content sliding under their finger.
  const calmed =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const armed = pull >= TRIGGER;
  const showing = pull > 0 || busy || result !== "idle";
  const offset = busy ? TRIGGER : result !== "idle" ? TRIGGER : pull;

  return (
    <div ref={hostRef} className="relative min-h-0 flex-1">
      <div
        aria-hidden={!showing}
        className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center will-change-transform"
        style={{
          transform: `translateY(${Math.max(offset, 0) - 44}px)`,
          opacity: showing ? 1 : 0,
          transition: state.current.active
            ? "none"
            : "transform 220ms cubic-bezier(.22,1,.36,1), opacity 160ms ease",
        }}
      >
        <span
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-full border border-border/60 bg-background/95 px-3 py-1.5 text-xs font-medium text-foreground shadow-lg backdrop-blur"
        >
          {busy ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Refreshing
            </>
          ) : result === "ok" ? (
            <>
              <Check className="size-3.5 text-emerald-600" aria-hidden />
              Updated
            </>
          ) : result === "offline" ? (
            <>
              <CloudOff className="size-3.5 text-amber-600" aria-hidden />
              You are offline
            </>
          ) : result === "error" ? (
            <>
              <RotateCcw className="size-3.5 text-destructive" aria-hidden />
              Unable to refresh — pull again
            </>
          ) : (
            <>
              <ArrowDown
                className="size-3.5 transition-transform duration-200"
                style={{ transform: armed ? "rotate(180deg)" : "none" }}
                aria-hidden
              />
              {armed ? "Release to refresh" : "Pull to refresh"}
            </>
          )}
        </span>
      </div>

      <div
        className="will-change-transform"
        style={{
          transform: calmed
            ? "none"
            : `translateY(${(busy ? Math.min(pull, TRIGGER) : pull) * 0.4}px)`,
          transition: calmed || state.current.active
            ? "none"
            : "transform 260ms cubic-bezier(.22,1,.36,1)",
        }}
      >
        {children}
      </div>
    </div>
  );
}
