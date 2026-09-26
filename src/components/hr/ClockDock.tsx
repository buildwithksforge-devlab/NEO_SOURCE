import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Clock, GripVertical, LogIn, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useClockIn, useClockOut, useMyEmployee, useMyOpenShift } from "@/lib/hr-data";
import { clockTime, hoursFromMinutes, type Row } from "@/lib/hr";
import {
  clockState,
  elapsedMinutes,
  extraMinutes,
  scheduledMinutes,
  useMyShiftToday,
} from "@/lib/hr-clock";
import { cn } from "@/lib/utils";

/**
 * Floating clock for the first screen a member of staff opens.
 *
 * It writes the same attendance record as My HR and the HR clock screen — the
 * dock is only a shortcut, never a second set of times. Hovering reveals the
 * shift it is being measured against and how long the person has been on.
 */
const DOCK_POSITION_KEY = "neo.clock-dock.position";

type DockOffset = { right: number; bottom: number };

/** Keeps the dock on screen after a resize, a zoom or a smaller device. */
function clampOffset(offset: DockOffset): DockOffset {
  if (typeof window === "undefined") return offset;
  const maxRight = Math.max(0, window.innerWidth - 120);
  const maxBottom = Math.max(0, window.innerHeight - 80);
  return {
    right: Math.min(Math.max(offset.right, 8), maxRight),
    bottom: Math.min(Math.max(offset.bottom, 8), maxBottom),
  };
}

/**
 * Where the person last parked the dock.
 *
 * Read after mount, never during render, so the server and the browser agree
 * on the first paint. It is a display preference only — no attendance record
 * depends on it.
 */
function useDockPosition() {
  const [offset, setOffset] = useState<DockOffset | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DOCK_POSITION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DockOffset;
        if (typeof parsed?.right === "number" && typeof parsed?.bottom === "number") {
          setOffset(clampOffset(parsed));
        }
      }
    } catch {
      /* a corrupt preference simply means the default corner */
    }
  }, []);

  useEffect(() => {
    if (!offset) return;
    const onResize = () => setOffset((current) => (current ? clampOffset(current) : current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [offset]);

  const save = useCallback((next: DockOffset) => {
    const clamped = clampOffset(next);
    setOffset(clamped);
    try {
      window.localStorage.setItem(DOCK_POSITION_KEY, JSON.stringify(clamped));
    } catch {
      /* private browsing: the dock still moves, it just will not be remembered */
    }
  }, []);

  return { offset, save };
}

export function ClockDock() {
  const me = useMyEmployee();
  const employeeId = me.data?.["id"] as string | undefined;
  const openShift = useMyOpenShift(employeeId);
  const shift = useMyShiftToday(employeeId);
  const clockIn = useClockIn();
  const clockOut = useClockOut();
  const [now, setNow] = useState(() => new Date());
  const { offset, save } = useDockPosition();
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; right: number; bottom: number } | null>(
    null,
  );

  const startDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const base = offset ?? {
      right: window.innerWidth - (event.currentTarget.closest("[data-clock-dock]") as HTMLElement | null)!.getBoundingClientRect().right,
      bottom: window.innerHeight - (event.currentTarget.closest("[data-clock-dock]") as HTMLElement | null)!.getBoundingClientRect().bottom,
    };
    dragRef.current = { startX: event.clientX, startY: event.clientY, ...base };
    setDragging(true);
  };

  const moveDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = dragRef.current;
    if (!start) return;
    save({
      right: start.right - (event.clientX - start.startX),
      bottom: start.bottom - (event.clientY - start.startY),
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  };

  /** Keyboard users move it too, in comfortable steps. */
  const nudge = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 48 : 16;
    const base = offset ?? { right: 16, bottom: 16 };
    const moves: Record<string, DockOffset> = {
      ArrowLeft: { ...base, right: base.right + step },
      ArrowRight: { ...base, right: base.right - step },
      ArrowUp: { ...base, bottom: base.bottom + step },
      ArrowDown: { ...base, bottom: base.bottom - step },
    };
    const next = moves[event.key];
    if (!next) return;
    event.preventDefault();
    save(next);
  };

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!me.data) return null;

  const open = (openShift.data ?? null) as Row | null;
  const scheduled = scheduledMinutes((shift.data ?? [])[0] ?? null);
  const worked = open ? elapsedMinutes(open["clock_in_at"], now) : 0;
  const extra = extraMinutes(worked, scheduled);
  const state = clockState(open, scheduled, now);
  const busy = clockIn.isPending || clockOut.isPending;

  return (
    <div
      data-clock-dock
      className={cn(
        "pointer-events-none fixed z-40 flex justify-end",
        offset ? "" : "bottom-4 right-4 sm:bottom-6 sm:right-6",
      )}
      style={offset ? { right: offset.right, bottom: offset.bottom } : undefined}
    >
      <div
        className={cn(
          "pointer-events-auto group flex items-center gap-2 rounded-2xl border p-2 shadow-lg backdrop-blur",
          "surface-panel border-outline-subtle",
          dragging ? "shadow-2xl ring-1 ring-primary/40" : "transition-all",
          state === "over_schedule" ? "ring-1 ring-warning/50" : "",
        )}
      >
        <button
          type="button"
          aria-label="Move the clock. Drag, or use the arrow keys."
          title="Drag to move"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={nudge}
          className={cn(
            "-ml-0.5 flex size-7 shrink-0 touch-none items-center justify-center rounded-lg text-muted-foreground",
            "hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            dragging ? "cursor-grabbing bg-muted text-foreground" : "cursor-grab",
          )}
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
        <div className="hidden max-w-0 overflow-hidden pl-1 text-xs transition-all group-hover:max-w-[15rem] group-focus-within:max-w-[15rem] sm:block">
          <p className="whitespace-nowrap font-medium text-foreground">
            {open ? `On since ${clockTime(open["clock_in_at"])} · ${hoursFromMinutes(worked)}` : "Not clocked in"}
          </p>
          <p className="whitespace-nowrap text-muted-foreground">
            {scheduled === null
              ? "No published shift for today"
              : `Scheduled ${hoursFromMinutes(scheduled)}${extra > 0 ? ` · ${hoursFromMinutes(extra)} extra` : ""}`}
          </p>
          <Link
            to="/hr/clock"
            className="whitespace-nowrap font-medium text-primary underline-offset-4 hover:underline"
          >
            Open time &amp; attendance
          </Link>
        </div>
        <Button
          size="sm"
          variant={open ? "default" : "outline"}
          disabled={busy}
          className="rounded-xl"
          onClick={() =>
            open
              ? clockOut.mutate({ record: open })
              : clockIn.mutate({ employee: me.data as Row, source: "web" })
          }
        >
          {open ? <LogOut className="mr-1.5 size-4" aria-hidden /> : <LogIn className="mr-1.5 size-4" aria-hidden />}
          {open ? "Clock out" : "Clock in"}
        </Button>
        <span className="sr-only">
          <Clock aria-hidden /> Attendance clock
        </span>
      </div>
    </div>
  );
}
