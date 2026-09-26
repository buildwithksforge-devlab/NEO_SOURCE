import { useState, type ReactNode } from "react";
import { Fingerprint, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/common/DataDisplay";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { titleCase } from "@/lib/pms";
import {
  useFolioIdentity,
  useFolioTrace,
  type FolioIdentity,
  type FolioTraceEvent,
} from "@/lib/folio-identity";

/**
 * The one rendering of canonical folio identity.
 *
 * Guest statements, refunds, account ledgers and the folio page all show the
 * same facts in the same order, so a folio can never appear to belong to a
 * different guest, account, reservation or room depending on which screen the
 * reader happens to be on.
 */

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd className={`mt-0.5 truncate text-sm text-foreground ${mono ? "neo-atomic" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

export function FolioIdentityFields({ identity }: { identity: FolioIdentity }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      <Field label="Folio number" value={identity.folioNumber} mono />
      <Field
        label="Guest"
        value={identity.guestEmail ? `${identity.guestName} · ${identity.guestEmail}` : identity.guestName}
      />
      <Field label="Company / account" value={identity.companyName} />
      <Field label="Reservation" value={identity.confirmationNumber} mono />
      <Field label="Room" value={identity.roomNumber} />
      <Field label="Property" value={identity.propertyName} />
      <Field label="Stay dates" value={identity.stay} />
      <Field label="Billing instructions" value={identity.billingInstructions} />
      <Field label="Folio status" value={titleCase(identity.status)} />
      <Field label="Folio type" value={titleCase(identity.folioType)} />
    </dl>
  );
}

/** Compact one-line identity for rows in refunds, statements and ledgers. */
export function FolioIdentityLine({ folioId }: { folioId: string | null | undefined }) {
  const { identity, isLoading } = useFolioIdentity(folioId);
  if (!folioId) return null;
  if (isLoading || !identity) {
    return <span className="text-xs text-muted-foreground">Loading folio identity…</span>;
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <Receipt className="size-3 shrink-0" aria-hidden />
      <span className="neo-atomic">{identity.folioNumber}</span>
      <span className="truncate">
        {identity.guestName}
        {identity.companyName !== "—" ? ` · ${identity.companyName}` : ""}
      </span>
      <span>
        Room {identity.roomNumber} · {identity.confirmationNumber}
      </span>
      <span className="truncate">{identity.stay}</span>
      <FolioTraceDrawer folioId={folioId} trigger="link" />
    </span>
  );
}

/**
 * Folio trace.
 *
 * Identity on top, then every stored operational event, housekeeping task and
 * notification raised against this folio's reservation and room, newest first.
 */
export function FolioTraceDrawer({
  folioId,
  trigger = "button",
  children,
}: {
  folioId: string | null | undefined;
  trigger?: "button" | "link";
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  if (!folioId) return null;

  return (
    <>
      {children ? (
        <span onClick={() => setOpen(true)} role="button" tabIndex={0}
          onKeyDown={(e) => (e.key === "Enter" ? setOpen(true) : undefined)}>
          {children}
        </span>
      ) : trigger === "link" ? (
        <button
          type="button"
          className="text-primary underline-offset-4 hover:underline"
          onClick={() => setOpen(true)}
        >
          Trace folio
        </button>
      ) : (
        <Button variant="outline" onClick={() => setOpen(true)}>
          <Fingerprint className="mr-2 size-4" /> Trace folio
        </Button>
      )}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          {open ? <FolioTraceBody folioId={folioId} /> : null}
        </SheetContent>
      </Sheet>
    </>
  );
}


/**
 * The trace queries only run while the drawer is open, so a closed drawer
 * costs nothing and never reads the record speculatively.
 */
function FolioTraceBody({ folioId }: { folioId: string }) {
  const { identity } = useFolioIdentity(folioId);
  const trace = useFolioTrace(identity);

  return (
    <>
          <SheetHeader>
            <SheetTitle>Folio trace</SheetTitle>
            <SheetDescription>
              Who and what this folio belongs to, and every operational event, task and
              notification recorded against its reservation and room.
            </SheetDescription>
          </SheetHeader>

          {identity ? (
            <div className="mt-4 space-y-5">
              <div className="surface-inset rounded-xl p-4">
                <FolioIdentityFields identity={identity} />
              </div>

              <div>
                <h3 className="mb-2 text-sm font-semibold">Operational chronology</h3>
                {trace.isLoading ? (
                  <p className="text-sm text-muted-foreground">Reading the record…</p>
                ) : (trace.data ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No operational event has been recorded against this folio yet.
                  </p>
                ) : (
                  <ol className="space-y-2">
                    {(trace.data ?? []).map((e: FolioTraceEvent) => (
                      <li key={e.id} className="rounded-lg border border-outline-subtle p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm font-medium capitalize">{e.title}</span>
                          <StatusPill tone="default">{e.kind}</StatusPill>
                        </div>
                        {e.detail ? (
                          <p className="mt-1 text-xs text-muted-foreground">{e.detail}</p>
                        ) : null}
                        <p className="mt-1 text-[0.7rem] text-muted-foreground">
                          {new Date(e.at).toLocaleString()}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">Loading folio identity…</p>
          )}
    </>
  );
}
