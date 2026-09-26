import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useItemModifierGroups } from "@/lib/pos-data";

export type AddItemChoice = {
  quantity: number;
  instructions: string;
  allergyNote: string;
  modifiers: {
    group_id: string;
    option_id: string;
    group_name: string;
    option_name: string;
    extra_charge: number;
  }[];
};

/**
 * How a waiter says "no onions, extra hot, table 4 is allergic to peanuts".
 *
 * Choices come from the item's own configured modifier groups so the extra
 * charge is priced from the catalogue, never typed. Everything captured here is
 * written with the line itself — before submission — so it reaches the station
 * ticket the kitchen works from and the order's audit trail.
 */
export function AddItemDialog({
  item,
  onOpenChange,
  onConfirm,
  busy,
}: {
  item: { id: string; name: string; base_price: number } | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (choice: AddItemChoice) => void;
  busy?: boolean;
}) {
  const groups = useItemModifierGroups(item?.id);
  const [quantity, setQuantity] = useState(1);
  const [instructions, setInstructions] = useState("");
  const [allergyNote, setAllergyNote] = useState("");
  const [picked, setPicked] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (item) {
      setQuantity(1);
      setInstructions("");
      setAllergyNote("");
      setPicked({});
    }
  }, [item]);

  const chosen = useMemo(() => {
    const out: AddItemChoice["modifiers"] = [];
    for (const g of groups.data ?? []) {
      for (const optionId of picked[g.id] ?? []) {
        const option = g.modifier_options.find((o) => o.id === optionId);
        if (!option) continue;
        out.push({
          group_id: g.id,
          option_id: option.id,
          group_name: g.name,
          option_name: option.name,
          extra_charge: Number(option.extra_charge ?? 0),
        });
      }
    }
    return out;
  }, [groups.data, picked]);

  const missingRequired = (groups.data ?? []).filter(
    (g) => g.required && (picked[g.id] ?? []).length === 0,
  );

  const toggle = (group: { id: string; multi_select: boolean | null }, optionId: string) =>
    setPicked((prev) => {
      const current = prev[group.id] ?? [];
      if (!group.multi_select) {
        return { ...prev, [group.id]: current.includes(optionId) ? [] : [optionId] };
      }
      return {
        ...prev,
        [group.id]: current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId],
      };
    });

  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{item?.name ?? "Add item"}</DialogTitle>
          <DialogDescription>
            Set the quantity, any choices and anything the kitchen needs to know.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="add-item-quantity">Quantity</Label>
            <Input
              id="add-item-quantity"
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>

          {(groups.data ?? []).map((g) => (
            <fieldset key={g.id} className="space-y-2">
              <legend className="text-sm font-medium">
                {g.name}
                {g.required ? <span className="text-destructive"> *</span> : null}
              </legend>
              {g.modifier_options
                .filter((o) => o.active !== false)
                .map((o) => (
                  <label key={o.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={(picked[g.id] ?? []).includes(o.id)}
                      onCheckedChange={() => toggle(g, o.id)}
                      aria-label={`${g.name}: ${o.name}`}
                    />
                    <span>{o.name}</span>
                    {Number(o.extra_charge ?? 0) > 0 ? (
                      <span className="text-xs text-muted-foreground">
                        +{Number(o.extra_charge).toLocaleString()}
                      </span>
                    ) : null}
                  </label>
                ))}
            </fieldset>
          ))}

          <div className="space-y-1.5">
            <Label htmlFor="add-item-instructions">Special instructions</Label>
            <Textarea
              id="add-item-instructions"
              rows={2}
              placeholder="No onions, well done, serve with the mains…"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-item-allergy">Allergy note</Label>
            <Input
              id="add-item-allergy"
              placeholder="Only if the guest has told you of an allergy"
              value={allergyNote}
              onChange={(e) => setAllergyNote(e.target.value)}
            />
          </div>

          {missingRequired.length ? (
            <p className="text-xs text-destructive">
              Choose an option for {missingRequired.map((g) => g.name).join(", ")}.
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || missingRequired.length > 0}
            onClick={() =>
              onConfirm({
                quantity,
                instructions: instructions.trim(),
                allergyNote: allergyNote.trim(),
                modifiers: chosen,
              })
            }
          >
            Add to bill
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
