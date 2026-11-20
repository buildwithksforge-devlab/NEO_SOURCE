import { useState } from "react";
import { Utensils } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BrandButton, useWorkspace } from "@/components/public/PublicAppShell";
import { useGuestMenuModifiers } from "@/lib/guest-ordering";
import { money } from "@/lib/public-delivery";

export function DeliveryItemSheet({ item, pending, available = true, disabled = false, onClose, onAdd, onSignIn }: {
  item: { id: string; name: string; description: string; image: string | null; price: number; currency: string };
  pending: boolean;
  available?: boolean;
  disabled?: boolean;
  onClose: () => void;
  onAdd: (options: { optionIds: string[]; quantity: number }) => void;
  onSignIn?: (() => void) | undefined;
}) {
  const workspace = useWorkspace();
  const modifiers = useGuestMenuModifiers(workspace.organization_id, [item.id], available && !disabled && !onSignIn);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);
  const groups = modifiers.data?.[item.id] ?? [];
  const optionTotal = groups.reduce((total, group) => total + group.options.reduce(
    (sum, option) => sum + (selected[group.group_id]?.includes(option.option_id) ? Number(option.extra_charge ?? 0) : 0),
    0,
  ), 0);
  const minimum = (group: (typeof groups)[number]) => Math.max(group.required ? 1 : 0, group.min_select ?? 0);
  const maximum = (group: (typeof groups)[number]) => group.multi_select ? group.max_select ?? group.options.length : 1;
  const valid = groups.every((group) => {
    const count = selected[group.group_id]?.length ?? 0;
    return count >= minimum(group) && count <= maximum(group);
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="neo-delivery-item-sheet max-h-[90dvh] max-w-lg gap-0 overflow-hidden rounded-3xl border-slate-200 bg-white p-0 text-slate-950" style={{ accentColor: workspace.primary_color }}>
        <DialogBody>
        <div className="grid h-44 place-items-center overflow-hidden bg-slate-100 text-slate-500 sm:h-52">
          {item.image ? <img src={item.image} alt="" className="size-full object-cover" /> : <Utensils className="size-9" aria-hidden />}
        </div>
        <div className="space-y-5 px-5 py-5">
        <DialogHeader>
          <DialogTitle className="text-2xl">{item.name}</DialogTitle>
          <DialogDescription>{item.description || money(item.price, item.currency)}</DialogDescription>
        </DialogHeader>
        {available && onSignIn ? <p className="text-sm text-slate-600">Sign in to choose options for this dish.</p> : !available || disabled ? null : modifiers.isError ? (
          <button className="min-h-11 text-left text-sm font-semibold underline" onClick={() => void modifiers.refetch()}>Options couldn’t load. Retry</button>
        ) : modifiers.isPending ? <p role="status" className="text-sm">Loading options…</p> : groups.map((group) => (
          <fieldset key={group.group_id} className="divide-y divide-slate-100">
            <legend className="text-sm font-semibold">{group.name} <span className="font-normal text-slate-600">{minimum(group) > 0 ? `· Choose at least ${minimum(group)}` : "· Optional"}</span></legend>
            {group.options.map((option) => {
              const groupSelection = selected[group.group_id] ?? [];
              const checked = groupSelection.includes(option.option_id);
              return (
                <label key={option.option_id} className="flex min-h-11 items-center gap-3 text-sm">
                  <input type="checkbox" checked={checked} disabled={!checked && maximum(group) !== 1 && groupSelection.length >= maximum(group)} onChange={() => {
                    const next = checked ? groupSelection.filter((id) => id !== option.option_id) : maximum(group) === 1 ? [option.option_id] : [...groupSelection, option.option_id];
                    setSelected({ ...selected, [group.group_id]: next });
                  }} />
                  <span className="flex-1">{option.name}</span>
                  {option.extra_charge ? <span>{money(option.extra_charge, item.currency)}</span> : null}
                </label>
              );
            })}
          </fieldset>
        ))}
        </div>
        </DialogBody>
        <div className="neo-delivery-sheet-actions flex shrink-0 flex-wrap items-center gap-3 border-t border-slate-200 bg-white px-5 pt-3">
          {available && !onSignIn ? <div className="neo-quantity-control">
            <button aria-label="Decrease quantity" disabled={quantity <= 1 || pending} onClick={() => setQuantity(quantity - 1)}>−</button>
            <output aria-label="Quantity">{quantity}</output>
            <button aria-label="Increase quantity" disabled={quantity >= 50 || pending} onClick={() => setQuantity(quantity + 1)}>+</button>
          </div> : null}
          {available ? (
            <BrandButton className="flex-1 flex-wrap" disabled={!onSignIn && (pending || disabled || !modifiers.isSuccess || !valid)}
              onClick={onSignIn ?? (() => onAdd({ optionIds: Object.values(selected).flat(), quantity }))}>
              {onSignIn ? "Sign in to add" : pending ? "Adding…" : <><span>Add to cart</span><span>{money((item.price + optionTotal) * quantity, item.currency)}</span></>}
            </BrandButton>
          ) : <p className="w-full py-2 text-center font-semibold">Currently unavailable</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
