import { useEffect } from "react";
import { Hand, LayoutGrid, Rows3, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DENSITY_LABELS, hydrateDensity, useDensity, type Density } from "@/lib/density";

const OPTIONS: { value: Density; icon: typeof Rows3 }[] = [
  { value: "comfortable", icon: LayoutGrid },
  { value: "compact", icon: Rows3 },
  { value: "touch", icon: Hand },
];

/**
 * Shared density control with the three official modes.
 *
 * Responsive shape, one component:
 * - desktop  — full segmented Comfortable / Compact / Touch
 * - tablet   — the same segmented track with icons and short labels
 * - phone    — a single button opening a menu (`variant="menu"`), so the
 *              control can never wrap onto the period/date row or collide
 *              with the property selector.
 *
 * It changes spacing and target size only — no figure, row or panel is
 * hidden in any mode, and it never affects access.
 */
export function DensityToggle({
  className,
  variant = "segmented",
}: {
  className?: string;
  variant?: "segmented" | "menu";
}) {
  const { density, setDensity } = useDensity();

  // Read the stored preference after hydration so SSR and the client agree.
  useEffect(() => {
    hydrateDensity();
  }, []);

  if (variant === "menu") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            data-density-toggle="menu"
            aria-label="Display density"
            title={`Display density — ${DENSITY_LABELS[density]}`}
            className={cn("size-10 shrink-0 rounded-xl text-muted-foreground", className)}
          >
            <SlidersHorizontal className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel>Display density</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={density}
            onValueChange={(v) => setDensity(v as Density)}
          >
            {OPTIONS.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value}>
                {DENSITY_LABELS[o.value]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="Display density"
      data-density-toggle
      className={cn("neo-segment shrink-0", className)}
    >
      {OPTIONS.map((o) => {
        const Icon = o.icon;
        const label = DENSITY_LABELS[o.value];
        const active = density === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${label} density`}
            title={`${label} density`}
            onClick={() => setDensity(o.value)}
            className={cn(
              "inline-flex min-h-9 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors sm:px-3",
              active
                ? "bg-chip-selected text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden />
            <span className="hidden md:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
