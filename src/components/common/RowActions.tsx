import { useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmAction } from "@/components/common/ConfirmAction";

/**
 * The one row-level action menu for catalogue lists.
 *
 * Every list that lets someone add a record should let them correct it and
 * take it out of use again, and it should read the same way everywhere:
 *
 *   • Edit sits first, because it is the ordinary act;
 *   • Deactivate is offered whenever the record has an in-use flag — it is the
 *     safe retirement, and history keeps resolving;
 *   • Delete is last, marked destructive, and is refused by the database when
 *     anything already refers to the record.
 *
 * The whole menu is absent when the account may not manage the record, so a
 * control is never shown that would only fail.
 */
export type RowActionsProps = {
  /** Named exactly as it appears in the list, so the confirmation is unambiguous. */
  recordName: string;
  /** "package", "venue", "supplier" — lower case, used in the sentences. */
  entityLabel: string;
  canManage: boolean;
  /** Rendered inside the menu, above the rest — usually an Edit dialog trigger. */
  edit?: ReactNode | undefined;
  status?:
    | {
        active: boolean;
        onToggle: (next: boolean) => void;
        pending?: boolean | undefined;
        /** What stops being possible once it is deactivated. */
        deactivateEffect?: string | undefined;
      }
    | undefined;
  remove?:
    | {
        onConfirm: () => void;
        pending?: boolean | undefined;
        /** Blocks deletion while the record is still active. */
        disabled?: boolean | undefined;
      }
    | undefined;
};

export function RowActions({
  recordName,
  entityLabel,
  canManage,
  edit,
  status,
  remove,
}: RowActionsProps) {
  const [askRetire, setAskRetire] = useState(false);
  const [askDelete, setAskDelete] = useState(false);

  if (!canManage || (!edit && !status && !remove)) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" aria-label={`Actions for ${recordName}`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {edit ? <div className="px-1 py-0.5">{edit}</div> : null}
          {status ? (
            status.active ? (
              <DropdownMenuItem onSelect={() => setAskRetire(true)}>Deactivate</DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => status.onToggle(true)}>Reactivate</DropdownMenuItem>
            )
          ) : null}
          {remove ? (
            <>
              {edit || status ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                disabled={remove.disabled ?? false}
                onSelect={() => setAskDelete(true)}
              >
                Delete permanently
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {status ? (
        <ConfirmAction
          open={askRetire}
          onOpenChange={setAskRetire}
          title={`Deactivate ${entityLabel}`}
          recordName={recordName}
          description={
            status.deactivateEffect ??
            `It stops being offered on anything new from now on. Everything that already uses it keeps its record exactly as it is.`
          }
          impact="You can reactivate it at any time."
          confirmLabel="Deactivate"
          pending={status.pending ?? false}
          onConfirm={() => {
            status.onToggle(false);
            setAskRetire(false);
          }}
        />
      ) : null}

      {remove ? (
        <ConfirmAction
          open={askDelete}
          onOpenChange={setAskDelete}
          title={`Delete ${entityLabel}`}
          recordName={recordName}
          description="This removes the record for good and cannot be undone."
          impact="If anything already refers to it, the deletion is refused and nothing changes."
          confirmLabel="Delete permanently"
          destructive
          pending={remove.pending ?? false}
          onConfirm={() => {
            remove.onConfirm();
            setAskDelete(false);
          }}
        />
      ) : null}
    </>
  );
}
