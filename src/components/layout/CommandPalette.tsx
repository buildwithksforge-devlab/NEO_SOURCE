import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CornerDownLeft, Loader2, Search } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useTenant } from "@/lib/tenant";
import { usePagePermitted } from "@/components/common/PermittedLink";
import { buildNavSearchIndex, searchNav } from "@/lib/nav-search";
import { isSearchable, searchRecords, type RecordHit } from "@/lib/record-search";

/**
 * Command search.
 *
 * One entry point — Cmd/Ctrl+K — that reaches pages, records and actions
 * without hunting through navigation. Everything it offers has already passed
 * the same page-permission check the sidebar and route guard apply, so the
 * palette can never become a shortcut into a denied module.
 *
 * Accessibility: cmdk renders a listbox with managed active-descendant state
 * inside a Radix dialog, so focus is trapped while open, Escape closes and
 * returns focus to whatever the operator was doing, and every row is reachable
 * with the arrow keys alone. Result kinds are labelled in text, never by
 * colour alone.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { roleNames, isAdmin, can, permissionsLoaded, organizationId } = useAuth();
  const { activeBranchId } = useTenant();
  const canSeePage = usePagePermitted();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Records are a round trip; pages are local. Only the record half waits.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 180);
    return () => clearTimeout(timer);
  }, [query]);

  const navIndex = useMemo(
    () => buildNavSearchIndex(roleNames, isAdmin, can, permissionsLoaded),
    [roleNames, isAdmin, can, permissionsLoaded],
  );
  const pages = useMemo(
    () => (query.trim() ? searchNav(navIndex, query).slice(0, 6) : navIndex.slice(0, 6)),
    [navIndex, query],
  );

  const records = useQuery({
    queryKey: ["command-records", organizationId, activeBranchId, debounced],
    enabled: open && isSearchable(debounced) && Boolean(organizationId),
    staleTime: 15_000,
    queryFn: () =>
      searchRecords(
        supabase,
        { organizationId: organizationId ?? null, branchId: activeBranchId ?? null, canSeePage },
        debounced,
      ),
  });

  const grouped = useMemo(() => {
    const map = new Map<string, RecordHit[]>();
    for (const hit of records.data ?? []) {
      const list = map.get(hit.group) ?? [];
      list.push(hit);
      map.set(hit.group, list);
    }
    return [...map.entries()];
  }, [records.data]);

  // Actions are the verbs an operator reaches for by name rather than by
  // page. Each one is filtered by the destination it would open.
  const actions = useMemo(
    () =>
      [
        { label: "New reservation", to: "/pms/reservations/new" },
        { label: "Open arrivals", to: "/pms/arrivals" },
        { label: "Open departures", to: "/pms/departures" },
        { label: "Open in-house guests", to: "/pms/in-house" },
        { label: "Open kitchen display", to: "/pos/kds" },
        { label: "Open cashier till", to: "/finance/till" },
        { label: "Open posting & reconciliation", to: "/finance/posting" },
        { label: "Run end of day", to: "/finance/eod" },
      ].filter((action) => canSeePage(action.to)),
    [canSeePage],
  );

  const go = (to: string) => {
    onOpenChange(false);
    void navigate({ to });
  };

  const searching = records.isFetching && isSearchable(debounced);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search guests, reservations, folios, rooms, orders, suppliers…"
        aria-label="Search records, pages and actions"
      />
      <CommandList aria-busy={searching}>
        <CommandEmpty>
          {isSearchable(query)
            ? searching
              ? "Searching…"
              : "Nothing matches that search in the records you can open."
            : "Type at least two characters to search records."}
        </CommandEmpty>

        {searching ? (
          <div
            className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"
            role="status"
          >
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
            Searching records…
          </div>
        ) : null}

        {grouped.map(([group, hits]) => (
          <CommandGroup key={group} heading={group}>
            {hits.map((hit) => (
              <CommandItem
                key={`${hit.kind}-${hit.to}-${hit.title}`}
                value={`${hit.title} ${hit.subtitle} ${group}`}
                onSelect={() => go(hit.to)}
              >
                <Search className="mr-2 size-4 opacity-60" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{hit.title}</span>
                  {hit.subtitle ? (
                    <span className="ml-2 text-xs text-muted-foreground">{hit.subtitle}</span>
                  ) : null}
                </span>
                <span className="ml-2 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                  {group}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}

        {grouped.length && pages.length ? <CommandSeparator /> : null}

        {pages.length ? (
          <CommandGroup heading="Pages">
            {pages.map((page) => (
              <CommandItem
                key={page.to}
                value={`${page.label} ${page.module} ${page.keywords}`}
                onSelect={() => go(page.to)}
              >
                <page.icon className="mr-2 size-4 opacity-70" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{page.label}</span>
                <span className="ml-2 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                  {page.module}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {actions.length ? (
          <CommandGroup heading="Actions">
            {actions.map((action) => (
              <CommandItem
                key={action.to}
                value={`${action.label} action`}
                onSelect={() => go(action.to)}
              >
                <ArrowRight className="mr-2 size-4 opacity-70" aria-hidden />
                {action.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>

      <div className="flex items-center justify-between border-t px-3 py-2 text-[11px] text-muted-foreground">
        <span>Arrow keys to move, Enter to open, Escape to close.</span>
        <span className="inline-flex items-center gap-1">
          <CornerDownLeft className="size-3" aria-hidden /> Open
        </span>
      </div>
    </CommandDialog>
  );
}
