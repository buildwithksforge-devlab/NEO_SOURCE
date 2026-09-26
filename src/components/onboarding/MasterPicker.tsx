/**
 * Searchable picker for resolving a value in a file against a real NEØ record.
 *
 * A list of two hundred departments or four thousand stock items is not usable
 * as a plain dropdown, so every unresolved value gets a type-to-search picker
 * over the canonical masters only — nothing here can invent a record.
 */
import { useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { MasterOption } from "@/lib/onboarding/engine";

export function MasterPicker({
  options,
  value,
  onSelect,
  label,
  placeholder = "Search your records",
  disabled,
  onCreate,
  createLabel,
  emptyHint,
}: {
  options: MasterOption[];
  /** Currently chosen record id, or null when the value is deliberately unassigned. */
  value: string | null | undefined;
  onSelect: (id: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Supplied only where the shared resolution contract grants CREATE_INLINE
   * for this relationship. When absent, the picker never suggests creating.
   */
  onCreate?: ((label: string) => void) | undefined;
  /** e.g. "asset category" — used in the create line. */
  createLabel?: string | undefined;
  /** What to say when nothing matches. Comes from the contract, not this file. */
  emptyHint?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = options.find((option) => option.id === value);
  const typed = search.trim();
  // The create affordance is granted by the shared contract, not by whether
  // the administrator happened to type first. Typing only refines the name.
  const canCreate =
    Boolean(onCreate) && !options.some((o) => o.label.toLowerCase() === typed.toLowerCase() && typed);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">
            {selected ? selected.label : value === "" ? "Left unassigned" : "Choose a record"}
          </span>
          <ChevronsUpDown aria-hidden className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(22rem,90vw)] p-0" align="start">
        <Command>
          <CommandInput placeholder={placeholder} value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>
              {emptyHint ?? "No matching record in this workspace."}
            </CommandEmpty>
            {canCreate ? (
              <CommandGroup>
                <CommandItem
                  value={`__create__${typed}`}
                  onSelect={() => {
                    onCreate?.(typed);
                    setOpen(false);
                  }}
                >
                  <Plus aria-hidden className="mr-2 size-4" />
                  <span className="truncate">
                    Create {createLabel ? `${createLabel}` : "record"}
                    {typed ? ` “${typed}”` : ""}
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={`${option.label} ${(option.aliases ?? []).join(" ")}`}
                  onSelect={() => {
                    onSelect(option.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    aria-hidden
                    className={`mr-2 size-4 ${option.id === value ? "opacity-100" : "opacity-0"}`}
                  />
                  <span className="truncate">{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
