/**
 * Inline creation of a classification record, from inside an import.
 *
 * Offered only where the shared resolution contract grants CREATE_INLINE. The
 * dialog is deliberately a confirmation, not a shortcut: it proposes a
 * canonical spelling, shows how many rows the decision settles, names the
 * destination the record will live in, searches the hotel's existing records
 * one more time, and refuses to create a second copy of something that is
 * already configured. Nothing is written until the administrator confirms.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MasterOption } from "@/lib/onboarding/engine";
import type { MatchPolicy } from "@/lib/onboarding/matching";
import { similarity } from "@/lib/onboarding/engine-primitives";
import { proposeCanonical } from "@/lib/onboarding/canonicalisation";

/** "utensils" → "Utensils"; "coffee shop" → "Coffee Shop". A proposal only. */
export function proposeCanonicalName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) =>
      word.length <= 2 && word === word.toUpperCase()
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
}

export type CreateMasterRequest = {
  policy: MatchPolicy;
  /** The raw spelling found in the file. */
  value: string;
  occurrences: number;
  /** Where the value goes, in the hotel's words. */
  fieldLabel: string;
  /** Every other unresolved spelling for this relationship in the same batch. */
  batchValues?: string[];
};

export function CreateMasterDialog({
  request,
  options,
  onOpenChange,
  onConfirm,
  onUseExisting,
  pending,
  scopeNote,
}: {
  request: CreateMasterRequest | null;
  /** The hotel's existing records for this relationship, searched again here. */
  options: MasterOption[];
  onOpenChange: (open: boolean) => void;
  onConfirm: (name: string) => void;
  onUseExisting: (optionId: string) => void;
  pending: boolean;
  /** Which workspace and property the new record will belong to. */
  scopeNote: string;
}) {
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  /**
   * Shared canonicalisation: normalise objectively, search the hotel's records
   * again with the normalised value, cluster other spellings in this batch, and
   * separate spelling similarity from business-semantic similarity.
   */
  const canonical = useMemo(
    () =>
      request
        ? proposeCanonical(request.value, request.policy, options, request.batchValues ?? [])
        : null,
    [request, options],
  );
  const proposed = canonical ? canonical.proposed : "";
  const current = touched ? name : proposed;
  const typed = current.trim();

  /** Last-moment duplicate search, run against what the administrator typed. */
  const nearby = useMemo(() => {
    if (!typed) return [];
    return options
      .map((option) => ({
        option,
        score: Math.max(
          similarity(typed, option.label),
          ...(option.aliases ?? []).map((alias) => similarity(typed, alias)),
        ),
      }))
      .filter((entry) => entry.score >= 0.7)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }, [typed, options]);

  const exact = nearby.find((entry) => entry.option.label.trim().toLowerCase() === typed.toLowerCase());

  const close = (open: boolean) => {
    if (!open) {
      setName("");
      setTouched(false);
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={Boolean(request)} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        {request ? (
          <>
            <DialogHeader>
              <DialogTitle>Create {request.policy.label.toLowerCase()}</DialogTitle>
              <DialogDescription>
                Your file says “{request.value}” in {request.fieldLabel}. NEØ proposes one canonical record and
                maps every row carrying that spelling to it.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 text-sm">
              <div className="space-y-2">
                <Label htmlFor="canonical-name">Name of the new record</Label>
                <Input
                  id="canonical-name"
                  value={current}
                  onChange={(event) => {
                    setTouched(true);
                    setName(event.target.value);
                  }}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">{canonical?.reason}</p>
                {canonical && canonical.kind !== "already_canonical" && canonical.kind !== "existing_record" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setTouched(true);
                      setName(request.value);
                    }}
                  >
                    Keep my original spelling “{request.value}”
                  </Button>
                ) : null}
              </div>

              <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3 text-xs">
                <div>
                  <dt className="text-muted-foreground">Rows this settles</dt>
                  <dd className="font-medium">{request.occurrences} row(s)</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Where it will live</dt>
                  <dd className="font-medium">{request.policy.ownedBy}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-muted-foreground">Belongs to</dt>
                  <dd className="font-medium">{scopeNote}</dd>
                </div>
              </dl>

              {canonical?.variants.length ? (
                <div className="space-y-1 rounded-lg border border-border p-3 text-xs">
                  <p className="font-medium">Other spellings of this in your file</p>
                  <p className="text-muted-foreground">
                    {canonical.variants.join(", ")} — these look like the same classification, so one record can
                    serve them all. Resolve each of them to this record once it exists.
                  </p>
                </div>
              ) : null}

              {canonical?.semanticNeighbours.length ? (
                <div className="space-y-1 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
                  <p className="font-medium">Related, but possibly not the same thing</p>
                  {canonical.semanticNeighbours.map((neighbour) => (
                    <p key={`${neighbour.label}-${neighbour.optionId ?? "file"}`} className="text-muted-foreground">
                      {neighbour.reason}
                    </p>
                  ))}
                </div>
              ) : null}

              {exact ? (
                <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
                  <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <span>
                    You already have “{exact.option.label}”. NEØ will not create a second copy — use the record
                    you have.
                  </span>
                </div>
              ) : nearby.length ? (
                <div className="space-y-2 rounded-lg border border-border p-3 text-xs">
                  <p className="font-medium">Similar records you already have</p>
                  {nearby.map((entry) => (
                    <div key={entry.option.id} className="flex items-center justify-between gap-2">
                      <span>
                        {entry.option.label} · {Math.round(entry.score * 100)}% similar
                      </span>
                      <Button size="sm" variant="outline" onClick={() => onUseExisting(entry.option.id)}>
                        Use this one
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button disabled={!typed || pending || Boolean(exact)} onClick={() => onConfirm(typed)}>
                {pending ? <Loader2 aria-hidden className="mr-2 size-4 animate-spin" /> : null}
                Create and apply to {request.occurrences} row(s)
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
