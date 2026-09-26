import { useEffect } from "react";
import { Hand, LayoutGrid, Rows3, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DENSITY_LABELS,
  hydrateDensity,
  useDensity,
  type DensityPreference as Pref,
} from "@/lib/density";

const OPTIONS: { value: Pref; label: string; hint: string; icon: typeof Rows3 }[] = [
  {
    value: "auto",
    label: "Automatic",
    hint: "Follows your role and the device you are on.",
    icon: Wand2,
  },
  {
    value: "comfortable",
    label: DENSITY_LABELS.comfortable,
    hint: "Calm rhythm for analysis and review work.",
    icon: LayoutGrid,
  },
  {
    value: "compact",
    label: DENSITY_LABELS.compact,
    hint: "More rows on screen for registers and ledgers.",
    icon: Rows3,
  },
  {
    value: "touch",
    label: DENSITY_LABELS.touch,
    hint: "Larger targets for tablets and phones.",
    icon: Hand,
  },
];

/**
 * The full display-density preference control for profile/settings surfaces.
 *
 * It writes to the same store as the compact header toggle, so there is one
 * preference, not two. Density affects spacing and target size only — never
 * permissions, scoping or which records are visible.
 */
export function DensityPreferenceControl({ className }: { className?: string }) {
  const { preference, density, setPreference } = useDensity();

  useEffect(() => {
    hydrateDensity();
  }, []);

  return (
    <div className={cn("space-y-3", className)} data-density-preference-control>
      <div
        role="radiogroup"
        aria-label="Display density preference"
        className="grid gap-2 sm:grid-cols-2"
      >
        {OPTIONS.map((o) => {
          const Icon = o.icon;
          const active = preference === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setPreference(o.value)}
              className={cn(
                "flex min-h-11 items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                active
                  ? "border-primary/40 bg-chip-selected"
                  : "border-border hover:bg-muted/50",
              )}
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{o.label}</span>
                <span className="block text-xs text-muted-foreground">{o.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Currently showing <span className="font-medium text-foreground">{DENSITY_LABELS[density]}</span>. On small
        touch screens the accessible target size always wins, so compact rows are opened up automatically.
      </p>
    </div>
  );
}
