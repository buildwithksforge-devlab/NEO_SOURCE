/**
 * Menu item photograph control.
 *
 * File imports carry structured data only; the picture is attached here, in the
 * product surface, and stored per organisation in the private `menu-images`
 * bucket. The caller persists the returned path on the canonical menu item.
 */
import { useRef, useState } from "react";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { removeMenuImage, uploadMenuImage, useMenuImageUrl } from "@/lib/menu-images";
import { cn } from "@/lib/utils";

export function MenuItemImage({
  path,
  name,
  size = 40,
  className,
}: {
  path: string | null | undefined;
  name: string;
  size?: number;
  className?: string;
}) {
  const url = useMenuImageUrl(path);
  if (url.data) {
    return (
      <img
        src={url.data}
        alt={name}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className={cn("rounded-md border border-border object-cover", className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn(
        "inline-flex items-center justify-center rounded-md border border-dashed border-border text-muted-foreground",
        className,
      )}
    >
      <ImagePlus className="size-4" />
    </span>
  );
}

export function MenuImageField({
  value,
  itemName,
  onChange,
}: {
  value: string | null;
  itemName: string;
  onChange: (next: string | null) => void;
}) {
  const { organizationId } = useAuth();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function pick(file: File | undefined) {
    if (!file || !organizationId) return;
    setBusy(true);
    try {
      const previous = value;
      const next = await uploadMenuImage(organizationId, file);
      onChange(next);
      await removeMenuImage(previous);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="space-y-1.5">
      <Label>Item photo</Label>
      <div className="flex items-center gap-3">
        <MenuItemImage path={value} name={itemName || "Menu item"} size={56} />
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ImagePlus className="mr-2 size-4" />}
          {value ? "Replace" : "Add photo"}
        </Button>
        {value ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              void removeMenuImage(value);
              onChange(null);
            }}
          >
            <Trash2 className="mr-2 size-4" /> Remove
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">JPEG, PNG or WebP up to 5 MB. Shown on ordering surfaces.</p>
    </div>
  );
}
