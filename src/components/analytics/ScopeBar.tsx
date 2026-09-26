import { useState } from "react";
import { CalendarRange } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NeoDatePicker } from "@/components/common/DatePicker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTenant } from "@/lib/tenant";
import { isoDate } from "@/lib/analytics";
import { defaultScope, useBranchOptions, type AnalyticsScope } from "@/lib/analytics-data";

/** Shared analytics scope state: branch + explicit reporting period. */
export function useAnalyticsScope(days = 30) {
  const [scope, setScope] = useState<AnalyticsScope>(() => defaultScope(days));
  return { scope, setScope };
}

export function useCurrencySymbol() {
  const { tenant } = useTenant();
  return tenant.regional.currencySymbol || "";
}

const PRESETS = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

export function ScopeBar({
  scope,
  onChange,
  note,
  lockedPropertyLabel,
}: {
  scope: AnalyticsScope;
  onChange: (s: AnalyticsScope) => void;
  note?: string;
  /**
   * When set, the property is inherited from the global header and shown as a
   * read-only indicator. There is then only one source of property context.
   */
  lockedPropertyLabel?: string;
}) {
  const branches = useBranchOptions();

  const applyPreset = (days: number) => {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);
    onChange({ ...scope, from: isoDate(from), to: isoDate(to) });
  };

  return (
    <div className="mb-5 flex flex-col gap-3 rounded-xl border border-outline-subtle bg-surface-2/70 p-3 sm:p-3.5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(11rem,1.4fr)_minmax(8rem,1fr)_minmax(8rem,1fr)]">
        <div className="min-w-0">
          <label className="mb-1 block text-xs text-muted-foreground">Branch / property</label>
          {lockedPropertyLabel ? (
            <p
              data-testid="scope-locked-property"
              className="flex h-10 min-w-0 items-center truncate rounded-md border border-outline-subtle bg-surface-2 px-3 text-sm"
              title={`Working in ${lockedPropertyLabel}`}
            >
              Working in {lockedPropertyLabel}
            </p>
          ) : (
          <Select
            value={scope.branchId ?? "all"}
            onValueChange={(v) => onChange({ ...scope, branchId: v === "all" ? null : v })}
          >
            <SelectTrigger className="h-10 w-full">
              <SelectValue placeholder="All branches" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All permitted branches</SelectItem>
              {(branches.data ?? []).map((b) => (
                <SelectItem key={String(b["id"])} value={String(b["id"])}>
                  {String(b["name"])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          )}

        </div>

        <div className="min-w-0">
          <label className="mb-1 block text-xs text-muted-foreground">From</label>
          <NeoDatePicker
            className="w-full"
            value={scope.from}
            max={scope.to}
            onChange={(v) => onChange({ ...scope, from: v })}
            quick={["today", "this-week", "next-7", "this-month"]}
          />
        </div>
        <div className="min-w-0">
          <label className="mb-1 block text-xs text-muted-foreground">To</label>
          <NeoDatePicker
            className="w-full"
            value={scope.to}
            min={scope.from}
            onChange={(v) => onChange({ ...scope, to: v })}
            quick={["today", "this-week", "next-7", "this-month"]}
          />
        </div>
      </div>

      {/* Quick ranges scroll on a phone instead of shrinking to unreadable chips. */}
      <div
        data-action-cluster
        className="neo-scroll-x -mx-1 flex items-center gap-2 px-1 sm:mx-0 sm:flex-wrap sm:px-0"
      >
        {PRESETS.map((p) => (
          <Button
            key={p.days}
            size="sm"
            variant="outline"
            className="h-9 shrink-0"
            onClick={() => applyPreset(p.days)}
          >
            {p.label}
          </Button>
        ))}
      </div>

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <CalendarRange className="mt-0.5 size-3.5 shrink-0" />
        {note ?? "Filters narrow what you already have permission to see — they never widen it."}
      </p>
    </div>
  );
}
