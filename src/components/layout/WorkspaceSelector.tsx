import { Briefcase } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMyWorkspaces, useSwitchWorkspace } from "@/lib/workspaces";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

const itemClass =
  "text-popover-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=checked]:bg-chip-selected data-[state=checked]:text-chip-selected-foreground data-[state=checked]:font-semibold";

/**
 * Group selector. Present only for a person who belongs to more than one
 * group; everyone else sees no extra control at all.
 */
export function WorkspaceSelector({ className }: { className?: string }) {
  const { organizationId } = useAuth();
  const { data } = useMyWorkspaces();
  const switcher = useSwitchWorkspace();
  // Until the membership list has actually arrived, no group choice is shown.
  const workspaces = Array.isArray(data) ? data : [];

  if (workspaces.length < 2) return null;


  const current =
    workspaces.find((w) => w.is_current)?.organization_id ?? organizationId ?? "";

  return (
    <Select
      value={current}
      disabled={switcher.isPending}
      onValueChange={(v) => {
        if (v !== current) switcher.mutate(v);
      }}
    >
      <SelectTrigger
        className={cn(
          "h-10 w-full min-w-0 max-w-[15rem] gap-2 rounded-xl border-border bg-background/70 px-2.5 text-sm font-medium text-foreground shadow-sm transition-colors hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-primary/60 data-[state=open]:bg-primary-soft/40 sm:w-[12rem] [&>span]:min-w-0 [&>span]:truncate",
          className,
        )}
        aria-label="Select group"
      >
        <Briefcase className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <SelectValue placeholder="Select group" />
      </SelectTrigger>

      <SelectContent className="bg-popover text-popover-foreground">
        {workspaces.map((w) => (
          <SelectItem key={w.organization_id} value={w.organization_id} className={itemClass}>
            <span className="flex items-center gap-2">
              {w.organization_name}
              {w.membership_type === "external" ? (
                <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                  External
                </span>
              ) : null}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
