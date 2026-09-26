/**
 * Command-centre chrome for NEØ Intelligence: mode navigation, the contextual
 * Morning Brief and the "what changed" strip. Presentation only — every figure
 * arrives already derived from the deterministic engine.
 */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Command, Compass, ListChecks, MessageSquare, Scale, Sunrise } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/common/DataDisplay";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { describeChange } from "@/lib/intelligence-engine";
import type { BriefItem } from "@/lib/intelligence-engine";
import type { ChangeItem } from "@/lib/intelligence-types";

export const INTELLIGENCE_MODES = [
  { id: "my-work", label: "My work", icon: ListChecks },
  { id: "today", label: "Today", icon: Sunrise },
  { id: "ask", label: "Ask NEØ", icon: MessageSquare },
  { id: "discoveries", label: "Insights", icon: Compass },
  { id: "decisions", label: "Decisions", icon: Scale },
  { id: "explore", label: "Explore", icon: ListChecks },
] as const;


export type IntelligenceMode = (typeof INTELLIGENCE_MODES)[number]["id"];

/**
 * The persistent NEØ rail. It carries the modes, the live counts and — on wider
 * screens — stays beside the workspace so the reader never loses their place.
 * On phones it collapses to a single scrollable bar rather than shrinking.
 */
export function ModeNav({
  mode,
  onChange,
  onOpenCommand,
  counts = {},
  context,
  discovered,
}: {
  mode: IntelligenceMode;
  onChange: (m: IntelligenceMode) => void;
  onOpenCommand: () => void;
  /** Live counts shown beside a mode, e.g. { discoveries: 3, decisions: 2 }. */
  counts?: Partial<Record<IntelligenceMode, number>>;
  /** Scope line kept visible beneath the rail: property · period · comparison. */
  context?: string;
  /** Set when new findings arrived; shown calmly, never as a red badge. */
  discovered?: string | null;
}) {
  return (
    <div className="neo-rail sticky top-2 z-10 space-y-2 rounded-2xl border border-outline-subtle p-2">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <nav aria-label="Intelligence modes" data-testid="intelligence-modes" className="min-w-0">
          <ul className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {INTELLIGENCE_MODES.map((m) => {
              const Icon = m.icon;
              const active = mode === m.id;
              const badge = counts[m.id];
              return (
                <li key={m.id} className="shrink-0">
                  <button
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => onChange(m.id)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors",
                      active ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5 shrink-0" aria-hidden />
                    {m.label}
                    {badge ? (
                      <span className="rounded-full bg-chip px-1.5 text-[0.65rem] font-semibold tabular-nums text-chip-foreground">
                        {badge}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <Button size="sm" variant="outline" onClick={onOpenCommand} className="shrink-0">
          <Command className="size-3.5" /> <span className="hidden sm:inline">Command</span>
          <kbd className="ml-1 hidden rounded border border-outline-subtle px-1 text-[0.65rem] sm:inline">⌘K</kbd>
        </Button>
      </div>

      {context || discovered ? (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-outline-subtle px-1 pt-2">
          <p className="min-w-0 truncate text-xs text-muted-foreground">{context}</p>
          {discovered ? (
            <p
              data-testid="neo-found"
              aria-live="polite"
              className="neo-found inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary-soft px-2.5 py-1 text-[0.68rem] font-medium text-primary"
            >
              <span aria-hidden className="size-1.5 rounded-full bg-primary" /> {discovered}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Contextual 3–4 item brief. Empty when nothing material was detected. */
export function MorningBrief({
  items,
  onInvestigate,
}: {
  items: BriefItem[];
  onInvestigate: (topic: string) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="surface-quiet neo-card-pad rounded-xl text-sm">
        <p className="font-medium">Nothing material detected in this scope</p>
        <p className="mt-1 text-muted-foreground">
          No rule matched the operational records for this property and period. NEØ does not manufacture a briefing.
        </p>
      </div>
    );
  }
  return (
    <ol data-testid="morning-brief" className="grid gap-3 lg:grid-cols-2">
      {items.map((item, index) => (
        <li
          key={item.id}
          className={cn(
            "neo-brief-item flex min-w-0 flex-col gap-2 rounded-2xl border border-outline-subtle border-l-[3px] p-4",
            item.severity === "critical"
              ? "border-l-destructive"
              : item.severity === "warning"
                ? "border-l-warning"
                : "border-l-primary/50",
          )}
        >
          <div className="flex items-center gap-2">
            <span className="text-xs tabular-nums text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
            <p className="min-w-0 text-sm font-semibold">{item.headline}</p>
            <StatusPill tone={item.severity === "critical" ? "destructive" : item.severity === "warning" ? "warning" : "info"}>
              {item.severity}
            </StatusPill>
          </div>
          <p className="text-sm leading-snug text-muted-foreground">{item.detail}</p>
          <div data-action-cluster className="mt-auto flex flex-wrap gap-2 pt-1">
            {item.investigate ? (
              <Button size="sm" variant="secondary" onClick={() => onInvestigate(item.investigate as string)}>
                Investigate
              </Button>
            ) : null}
            {item.drillTo ? (
              <Button asChild size="sm" variant="outline">
                <Link to={item.drillTo}>See records</Link>
              </Button>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Current window against the immediately preceding comparable window. */
export function WhatChanged({ changes, loading }: { changes: ChangeItem[]; loading: boolean }) {
  if (loading) {
    return <p className="text-sm text-muted-foreground">Comparing with the previous period…</p>;
  }
  const material = changes.filter((c) => c.material);
  if (material.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing moved materially against the immediately preceding period of the same length.
      </p>
    );
  }
  return (
    <ul data-testid="what-changed" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {material.slice(0, 6).map((c) => (
        <li key={c.id} className="min-w-0 rounded-xl border border-outline-subtle bg-card/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-xs uppercase tracking-wide text-muted-foreground">{c.label}</p>
            <StatusPill tone={c.favourable === "bad" ? "warning" : c.favourable === "good" ? "success" : "info"}>
              {c.direction === "up" ? "▲" : c.direction === "down" ? "▼" : "="}{" "}
              {c.deltaPercent === null ? "new" : `${Math.abs(c.deltaPercent).toFixed(0)}%`}
            </StatusPill>
          </div>
          <p className="mt-1 text-sm leading-snug">{describeChange(c)}</p>
        </li>
      ))}
    </ul>
  );
}

/** ⌘K overlay for jumping between modes and asking a question. */
export function CommandOverlay({
  open,
  onOpenChange,
  onMode,
  onAsk,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onMode: (m: IntelligenceMode) => void;
  onAsk: (q: string) => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => {
    if (!open) setValue("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>NEØ command</DialogTitle>
          <DialogDescription>Jump to a mode, or ask a grounded question about your scope.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const q = value.trim();
            if (!q) return;
            onAsk(q);
            onOpenChange(false);
          }}
          className="space-y-3"
        >
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Ask NEØ anything…"
            aria-label="Ask NEØ anything"
            className="h-11 w-full rounded-xl border border-outline-subtle bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <ul className="grid grid-cols-2 gap-2">
            {INTELLIGENCE_MODES.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => {
                    onMode(m.id);
                    onOpenChange(false);
                  }}
                  className="w-full rounded-lg border border-outline-subtle px-3 py-2 text-left text-sm hover:bg-muted/60"
                >
                  {m.label}
                </button>
              </li>
            ))}
          </ul>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Registers the ⌘K / Ctrl+K shortcut for the command overlay. */
export function useCommandShortcut(open: (v: boolean) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}
