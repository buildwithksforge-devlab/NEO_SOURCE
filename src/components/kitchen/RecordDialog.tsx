import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export type FieldSpec = {
  name: string;
  label: string;
  type?: "text" | "number" | "textarea" | "select" | "date" | "datetime-local";
  options?: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
  hint?: string;
  full?: boolean;
};

type Values = Record<string, string>;

function initialValues(fields: FieldSpec[]): Values {
  return Object.fromEntries(fields.map((f) => [f.name, ""]));
}

/**
 * One small, reusable capture form. Values are returned as a plain record with
 * empty strings normalised to null and numeric fields coerced, so callers can
 * hand the result straight to a Supabase insert.
 */
export function RecordDialog({
  title,
  description,
  trigger,
  fields,
  submitLabel = "Save",
  pending,
  onSubmit,
  extra,
  extraInvalid,
  onOpenChange,
  contentClassName,
}: {
  title: string;
  description?: string;
  trigger: ReactNode;
  fields: FieldSpec[];
  submitLabel?: string;
  pending?: boolean;
  onSubmit: (values: Record<string, unknown>) => Promise<unknown> | unknown;
  /** Extra capture surface rendered below the fields (e.g. a repeatable row table). */
  extra?: ReactNode;
  /** Blocks submit while the extra surface is incomplete. */
  extraInvalid?: boolean;
  onOpenChange?: (open: boolean) => void;
  contentClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Values>(() => initialValues(fields));

  useEffect(() => {
    if (!open) setValues(initialValues(fields));
  }, [open, fields]);

  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));

  const missing = fields.filter((f) => f.required && !values[f.name]?.trim());

  async function submit() {
    if (missing.length > 0) return;
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = values[f.name]?.trim() ?? "";
      if (raw === "") {
        payload[f.name] = null;
        continue;
      }
      payload[f.name] = f.type === "number" ? Number(raw) : raw;
    }
    await onSubmit(payload);
    change(false);
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className={`max-h-[85vh] overflow-y-auto sm:max-w-xl ${contentClassName ?? ""}`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map((f) => (
            <div key={f.name} className={`space-y-2 ${f.full || f.type === "textarea" ? "sm:col-span-2" : ""}`}>
              <Label htmlFor={`fld-${f.name}`}>
                {f.label}
                {f.required ? <span className="ml-1 text-destructive">*</span> : null}
              </Label>
              {f.type === "textarea" ? (
                <Textarea
                  id={`fld-${f.name}`}
                  value={values[f.name] ?? ""}
                  placeholder={f.placeholder ?? ""}
                  onChange={(e) => set(f.name, e.target.value)}
                />
              ) : f.type === "select" ? (
                <Select value={values[f.name] ?? ""} onValueChange={(v) => set(f.name, v)}>
                  <SelectTrigger id={`fld-${f.name}`} aria-label={f.label}>
                    <SelectValue placeholder={f.placeholder ?? "Select"} />
                  </SelectTrigger>
                  <SelectContent>
                    {(f.options ?? []).map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={`fld-${f.name}`}
                  type={f.type ?? "text"}
                  value={values[f.name] ?? ""}
                  placeholder={f.placeholder ?? ""}
                  onChange={(e) => set(f.name, e.target.value)}
                />
              )}
              {f.hint ? <p className="text-xs text-muted-foreground">{f.hint}</p> : null}
            </div>
          ))}
        </div>
        {extra ? <div className="mt-4">{extra}</div> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => change(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={pending || missing.length > 0 || Boolean(extraInvalid)}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
