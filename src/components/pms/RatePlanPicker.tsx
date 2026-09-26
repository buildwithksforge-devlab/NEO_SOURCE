/**
 * Room & rate selection list for the New Reservation wizard.
 *
 * The rate plan is chosen from an explicit, keyboard-reachable radio list
 * rather than a dropdown: the operator can see every plan that genuinely
 * applies to the selected room type, and a click always lands on a real
 * `<button>` that updates wizard state deterministically.
 *
 * No price is calculated here — the list shows the stored plan price for
 * recognition only; the nightly rate always comes from `pms_quote_rate`.
 */
import { cn } from "@/lib/utils";
import { money } from "@/lib/pms";
import { EmptyState } from "@/components/common/StateSystem";

export type SelectableRatePlan = {
  id: string;
  name: string;
  code?: string | null;
  status?: string | null;
  base_rate?: number | string | null;
  currency?: string | null;
  room_type_id?: string | null;
  meal_plan_id?: string | null;
  corporate_only?: boolean | null;
};

/**
 * Plans applicable to the chosen room type: active plans whose `room_type_id`
 * matches exactly. Generic (null room type) plans and other room types are
 * never offered, and nothing is offered until a room type is chosen.
 */
export function selectableRatePlans<T extends SelectableRatePlan>(
  plans: T[] | undefined | null,
  roomTypeId: string | null | undefined,
): T[] {
  if (!roomTypeId) return [];
  return (plans ?? []).filter(
    (p) => (p.status ?? "active") === "active" && p.room_type_id === roomTypeId,
  );
}

export function RatePlanPicker({
  plans,
  roomTypeId,
  value,
  onSelect,
}: {
  plans: SelectableRatePlan[];
  roomTypeId: string | null;
  value: string;
  onSelect: (planId: string) => void;
}) {
  const options = selectableRatePlans(plans, roomTypeId);

  if (!roomTypeId) {
    return (
      <EmptyState
        inline
        title="Select a room type first"
        description="Rate plans are listed once the room type is known, so only applicable plans are offered."
      />
    );
  }

  if (options.length === 0) {
    return (
      <EmptyState
        inline
        title="No rate plan is configured for this room type"
        description="Ask an administrator to publish a rate plan for this room type in Rates & Taxes."
      />
    );
  }

  return (
    <div role="radiogroup" aria-label="Rate plan" className="grid gap-2">
      {options.map((plan) => {
        const selected = plan.id === value;
        return (
          <button
            key={plan.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onSelect(plan.id)}
            className={cn(
              "flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border hover:bg-muted/40",
            )}
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{plan.name}</span>
              {plan.code ? (
                <span className="block truncate text-xs text-muted-foreground">{plan.code}</span>
              ) : null}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {money(Number(plan.base_rate ?? 0), plan.currency ?? undefined)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Resolve the room type of a room handed off from Availability. */
export function roomTypeForRoom(
  rooms: Array<{ id: string; room_type_id?: string | null }> | undefined | null,
  roomId: string | null | undefined,
): string | null {
  if (!roomId) return null;
  return (rooms ?? []).find((r) => r.id === roomId)?.room_type_id ?? null;
}
