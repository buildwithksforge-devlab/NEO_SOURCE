import { useRef, useState, type ReactNode } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { normaliseBrandImage } from "@/lib/brand-image";
import { cn } from "@/lib/utils";

/**
 * Uploads brand artwork into the tenant branding record.
 *
 * The file is downscaled before it is handed upstream, so what is persisted
 * always fits inside the branding record and survives refresh, sign-out and
 * another device. An oversized original used to be stored raw, and the write
 * failed silently.
 */
export function ImageUploadField({
  label,
  hint,
  value,
  onChange,
  aspect = "square",
  className,
}: {
  label: string;
  hint?: string;
  value: string | null;
  onChange: (dataUrl: string | null) => void;
  aspect?: "square" | "wide" | "tall";
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = (file?: File) => {
    if (!file) return;
    setBusy(true);
    void normaliseBrandImage(file)
      .then((dataUrl) => onChange(dataUrl))
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : "That image could not be used."),
      )
      .finally(() => setBusy(false));
  };


  const box = {
    square: "aspect-square",
    wide: "aspect-[16/6]",
    tall: "aspect-[9/16] max-h-56",
  }[aspect];

  return (
    <div className={cn("space-y-2", className)}>
      <Label className="text-sm font-medium">{label}</Label>
      <div
        className={cn(
          "relative flex w-full items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-muted/40",
          box,
        )}
      >
        {value ? (
          <img src={value} alt={`${label} preview`} className="size-full object-contain p-2" />
        ) : (
          <span className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
            <ImagePlus className="size-5" />
            No file yet
          </span>
        )}
      </div>
      <div data-action-cluster className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Preparing…" : "Upload"}
        </Button>
        {value ? (

          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
            <Trash2 className="size-4" />
            Remove
          </Button>
        ) : null}
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
    </div>
  );
}

export function ColorField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} colour picker`}
          className="size-10 shrink-0 cursor-pointer rounded-lg border border-border bg-card p-1"
        />
        <Input value={value} onChange={(e) => onChange(e.target.value)} className="font-mono" />
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function FieldGrid({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 }) {
  return (
    <div
      className={cn(
        "grid gap-4",
        cols === 1 && "grid-cols-1",
        cols === 2 && "sm:grid-cols-2",
        cols === 3 && "sm:grid-cols-2 xl:grid-cols-3",
      )}
    >
      {children}
    </div>
  );
}
