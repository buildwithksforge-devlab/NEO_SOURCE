import { useNavigate } from "@tanstack/react-router";
import { Building2, Settings2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBranchScope } from "@/lib/branches";
import { cn } from "@/lib/utils";

const MANAGE = "__manage__";

/** Readable option styling in both light and dark contexts. */
const itemClass =
  "text-popover-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=checked]:bg-chip-selected data-[state=checked]:text-chip-selected-foreground data-[state=checked]:font-semibold";


/**
 * Global property selector. Options come straight from `public.branches`
 * (Supabase) and respect the user's property scope.
 */
export function PropertySelector({ className }: { className?: string }) {
  const navigate = useNavigate();
  const { branches, orgWide, canManage, activeBranchId, loading, setActiveBranchId } =
    useBranchScope();

  const manage = () => void navigate({ to: "/admin/branches" });

  if (!loading && branches.length === 0) {
    return canManage ? (
      <button
        onClick={manage}
        className={cn(
          "flex h-9 items-center gap-2 rounded-md border border-dashed border-border px-3 text-xs font-medium text-muted-foreground hover:border-primary hover:text-primary",
          className,
        )}
      >
        <Building2 className="size-4" /> Add first property
      </button>
    ) : (
      <span
        className={cn(
          "hidden h-9 items-center rounded-md border border-border px-3 text-xs text-muted-foreground sm:flex",
          className,
        )}
      >
        No property assigned
      </span>
    );
  }

  return (
    <Select
      value={activeBranchId}
      onValueChange={(v) => (v === MANAGE ? manage() : setActiveBranchId(v))}
    >
      {/* Presentation only — the value, options and switching behaviour above
          are untouched. Compact 44px-friendly control that truncates rather
          than wraps, and never grows past the space the header can spare. */}
      <SelectTrigger
        className={cn(
          "h-10 w-full min-w-0 max-w-[15rem] gap-2 rounded-xl border-border bg-background/70 px-2.5 text-sm font-medium text-foreground shadow-sm transition-colors hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-primary/60 data-[state=open]:bg-primary-soft/40 sm:w-[12.5rem] lg:w-[13.5rem] [&>span]:min-w-0 [&>span]:truncate",
          className,
        )}
        aria-label="Select property"
      >
        <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <SelectValue placeholder="Select property" />
      </SelectTrigger>

      <SelectContent className="bg-popover text-popover-foreground">
        {orgWide ? (
          <SelectItem value="all" className={itemClass}>
            All Properties
          </SelectItem>
        ) : null}
        {branches.map((b) => (
          <SelectItem key={b.id} value={b.id} className={itemClass}>
            {b.name}
          </SelectItem>
        ))}
        {canManage ? (
          <>
            <SelectSeparator />
            <SelectItem value={MANAGE} className={itemClass}>
              <span className="flex items-center gap-2">
                <Settings2 className="size-4" /> Manage Properties
              </span>
            </SelectItem>
          </>
        ) : null}
      </SelectContent>

    </Select>
  );
}
