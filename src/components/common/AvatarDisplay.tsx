import { useRef, useState } from "react";
import { Camera, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { initialsFor, removeAvatarObject, uploadAvatar, uploadAvatarFor, useAvatarUrl } from "@/lib/avatars";

/** Read-only avatar used anywhere a person is displayed. */
export function Avatar({
  path,
  name,
  size = 36,
  className,
}: {
  path: string | null | undefined;
  name: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const url = useAvatarUrl(path);
  const label = name?.trim() || "Account";
  if (url.data) {
    return (
      <img
        src={url.data}
        alt={label}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className={cn("rounded-full object-cover", className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.36) }}
      className={cn(
        "inline-flex items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground",
        className,
      )}
    >
      {initialsFor(name)}
    </span>
  );
}

/**
 * Photo control.
 *
 * By default it writes to the signed-in account's own storage folder. Pass
 * `targetUserId` to upload on behalf of another staff member — storage policy,
 * not this component, decides whether that write is allowed. The caller
 * persists the returned path.
 */
export function AvatarUploader({
  path,
  name,
  onChange,
  disabled,
  targetUserId,
  hint,
}: {
  path: string | null | undefined;
  name: string | null | undefined;
  onChange: (next: string | null) => Promise<void> | void;
  disabled?: boolean;
  targetUserId?: string | null;
  hint?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const previous = path;
      const next = targetUserId ? await uploadAvatarFor(targetUserId, file) : await uploadAvatar(file);
      await onChange(next);
      await removeAvatarObject(previous);
      toast.success("Profile photo updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function clear() {
    setBusy(true);
    try {
      const previous = path;
      await onChange(null);
      await removeAvatarObject(previous);
      toast.success("Profile photo removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the photo");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      <Avatar path={path} name={name} size={72} />
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          onClick={() => input.current?.click()}
        >
          {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Camera className="mr-2 size-4" />}
          {path ? "Change photo" : "Upload photo"}
        </Button>
        {path ? (
          <Button type="button" variant="ghost" size="sm" disabled={disabled || busy} onClick={() => void clear()}>
            <Trash2 className="mr-2 size-4" /> Remove
          </Button>
        ) : null}
        <p className="w-full text-xs text-muted-foreground">
          {hint ?? "JPEG, PNG, WebP or GIF up to 5 MB. Visible only inside your organisation."}
        </p>
      </div>
    </div>
  );
}
