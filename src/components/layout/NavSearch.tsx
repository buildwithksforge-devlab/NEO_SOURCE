import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { buildNavSearchIndex, searchNav } from "@/lib/nav-search";
import { cn } from "@/lib/utils";

/**
 * Sidebar navigation search — finds pages and modules the signed-in user is
 * authorized to open. It never searches operational records.
 */
export function NavSearch({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const navigate = useNavigate();
  const { roleNames, isAdmin, can, permissionsLoaded } = useAuth();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const index = useMemo(
    () => buildNavSearchIndex(roleNames, isAdmin, can, permissionsLoaded),
    [roleNames, isAdmin, can, permissionsLoaded],
  );
  const results = useMemo(() => searchNav(index, query), [index, query]);

  useEffect(() => setHighlight(0), [query]);

  const go = (to: string) => {
    setQuery("");
    inputRef.current?.blur();
    onNavigate?.();
    void navigate({ to });
  };

  return (
    <div data-page-search className="relative px-3 pb-2 pt-3">
      <Search className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-1/2 text-sidebar-foreground/50" />
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find a page or module…"
        aria-label="Find a page or module"
        role="combobox"
        aria-expanded={query.length > 0}
        autoComplete="off"
        className="h-9 rounded-lg border-sidebar-border bg-sidebar-accent/40 pl-9 pr-8 text-sm text-sidebar-accent-foreground placeholder:text-sidebar-foreground/50 focus-visible:border-sidebar-primary"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (query) setQuery("");
            else inputRef.current?.blur();
            return;
          }
          if (!results.length) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => (h + 1) % results.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => (h - 1 + results.length) % results.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            const target = results[highlight];
            if (target) go(target.to);
          }
        }}
      />
      {query ? (
        <button
          type="button"
          onClick={() => {
            setQuery("");
            inputRef.current?.focus();
          }}
          aria-label="Clear search"
          className="absolute right-5 top-1/2 -translate-y-1/2 rounded p-1 text-sidebar-foreground/60 hover:text-sidebar-accent-foreground"
        >
          <X className="size-3.5" />
        </button>
      ) : null}

      {query ? (
        <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-sidebar-border bg-sidebar-accent/30 p-1">
          {results.length === 0 ? (
            <p className="px-3 py-3 text-xs text-sidebar-foreground/70">
              No authorized pages found
            </p>
          ) : (
            <ul role="listbox">
              {results.map((r, i) => (
                <li key={`${r.to}-${r.label}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === highlight}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => go(r.to)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm",
                      i === highlight
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-accent/60",
                    )}
                  >
                    <r.icon className="size-4 shrink-0 text-sidebar-primary" />
                    <span className="min-w-0">
                      <span className="block truncate">{r.label}</span>
                      <span className="block truncate text-[0.68rem] text-sidebar-foreground/60">
                        {r.module}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
