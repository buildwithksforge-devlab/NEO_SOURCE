import { useEffect, useState } from "react";
import { Copy, ExternalLink, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { StatusPill } from "@/components/common/DataDisplay";
import { useBranchMutations, type BranchRecord } from "@/lib/branches";

/** A readable address derived from the property name, offered as a suggestion. */
export function suggestPortalSlug(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const VALID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A hotel's own staff sign-in address.
 *
 * The address only says which hotel a person is signing in to. Who they are,
 * which hotel group they belong to, which property they are assigned to and
 * what they may open are all decided in the database after sign-in, so a
 * public address can never widen anybody's access.
 */
export function PropertyPortalPanel({
  branch,
  canManage,
}: {
  branch: BranchRecord;
  canManage: boolean;
}) {
  const { update } = useBranchMutations();
  const [slug, setSlug] = useState(branch.portal_slug ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSlug(branch.portal_slug ?? "");
  }, [branch.portal_slug]);

  const enabled = branch.portal_enabled !== false && Boolean(branch.portal_slug);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const url = branch.portal_slug ? `${origin}/h/${branch.portal_slug}` : "";

  const save = async (patch: Partial<BranchRecord>, message: string) => {
    setSaving(true);
    try {
      await update.mutateAsync({
        id: branch.id,
        patch: patch as never,
        previous: { portal_slug: branch.portal_slug, portal_enabled: branch.portal_enabled },
        action: "branch.portal_updated",
      });
      toast.success(message);
    } catch (error) {
      const text = (error as Error).message;
      toast.error(
        /duplicate key|unique/i.test(text)
          ? "That address is already used by another hotel. Choose a different one."
          : text,
      );
    } finally {
      setSaving(false);
    }
  };

  const saveSlug = async () => {
    const next = slug.trim().toLowerCase();
    if (!VALID.test(next)) {
      toast.error("Use lower-case letters, numbers and hyphens only, e.g. lakeside-hotel.");
      return;
    }
    await save({ portal_slug: next, portal_enabled: true }, "Hotel sign-in address saved");
  };

  return (
    <div className="mt-5 rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Link2 className="size-4 text-muted-foreground" />
          Hotel sign-in page
          <StatusPill tone={enabled ? "success" : "warning"}>
            {enabled ? "Live" : "Not published"}
          </StatusPill>
        </div>
        {canManage && branch.portal_slug ? (
          <div className="flex items-center gap-2 text-sm">
            <Label htmlFor={`portal-${branch.id}`} className="text-muted-foreground">
              Published
            </Label>
            <Switch
              id={`portal-${branch.id}`}
              checked={branch.portal_enabled !== false}
              disabled={saving}
              onCheckedChange={(v) =>
                void save(
                  { portal_enabled: v },
                  v ? "Hotel sign-in page published" : "Hotel sign-in page switched off",
                )
              }
            />
          </div>
        ) : null}
      </div>

      <p className="mt-2 text-sm text-muted-foreground">
        Staff of this hotel sign in at their own address and land straight in this property — its
        front office, its money and its printers. The address only chooses the hotel; membership,
        property assignment and permissions still decide what each person can open.
      </p>

      {canManage ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[16rem] flex-1 space-y-1.5">
            <Label htmlFor={`slug-${branch.id}`}>Address</Label>
            <div className="flex items-center gap-1">
              <span className="text-sm text-muted-foreground">{origin}/h/</span>
              <Input
                id={`slug-${branch.id}`}
                value={slug}
                placeholder={suggestPortalSlug(branch.name)}
                onChange={(e) => setSlug(e.target.value)}
              />
            </div>
          </div>
          <Button
            variant="outline"
            disabled={saving || !slug.trim()}
            onClick={() => void saveSlug()}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Save address
          </Button>
          {!slug.trim() ? (
            <Button variant="ghost" onClick={() => setSlug(suggestPortalSlug(branch.name))}>
              Suggest
            </Button>
          ) : null}
        </div>
      ) : null}

      {url ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <code className="rounded bg-background px-2 py-1 text-xs">{url}</code>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard
                .writeText(url)
                .then(() => toast.success("Link copied"))
                .catch(() => toast.error("Could not copy the link"));
            }}
          >
            <Copy className="size-4" /> Copy
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <a href={url} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" /> Open
            </a>
          </Button>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          No address set yet, so this hotel has no sign-in page of its own.
        </p>
      )}
    </div>
  );
}
