import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CalendarX, Lock, Plus } from "lucide-react";
import { NotConfiguredState } from "@/components/common/StateSystem";
import { StatusPill } from "@/components/common/DataDisplay";
import { TablePager, usePagedRows } from "@/components/common/TablePager";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import { titleCase, type Tone } from "@/lib/events";
import { cn } from "@/lib/utils";

/** Gate an events screen on a canonical `events.<feature>.<action>` capability. */
export function EventsGuard({
  feature = "bookings",
  action = "view",
  children,
}: {
  feature?: string;
  action?: string;
  children: ReactNode;
}) {
  const { can, loading } = useAuth();
  if (loading) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (!can("events", feature, action)) {
    return (
      <Card className="surface-panel">
        <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
          <span className="rounded-full bg-muted p-3 text-muted-foreground">
            <Lock className="size-5" />
          </span>
          <p className="text-base font-semibold">You do not have access to this Events screen</p>
          <p className="max-w-md text-sm text-muted-foreground">
            The <span className="font-mono text-xs">events.{feature}.{action}</span> permission is required. Ask an
            administrator to grant it from Roles &amp; Permissions.
          </p>
          <Link to="/workspace" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
            Back to dashboard
          </Link>
        </CardContent>
      </Card>
    );
  }
  return <>{children}</>;
}

/** Shown wherever a record can only be created against one chosen property. */
export function PropertyRequired({ what }: { what: string }) {
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/10 p-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 text-warning" />
        <p className="text-sm font-semibold text-foreground">Choose a property first</p>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {what} belongs to a single property. Pick one in the property selector at the top of the screen — “All
        Properties” is a viewing mode and cannot own records.
      </p>
    </div>
  );
}


export function EventsEmpty({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 px-6 py-12 text-center">
      <span className="rounded-full bg-muted p-3 text-muted-foreground">
        <CalendarX className="size-5" />
      </span>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      {action}
    </div>
  );
}

export { QueryState as EventsQueryState } from "@/components/common/StateSystem";

export function Pill({ tone, value }: { tone: Tone; value: string }) {
  return <StatusPill tone={tone}>{titleCase(value)}</StatusPill>;
}

export function NotConfigured({ label, note }: { label: string; note: string }) {
  return <NotConfiguredState inline feature={label} detail={note} />;
}

/* --------------------------- lightweight form kit --------------------------- */

export type FieldSpec = {
  name: string;
  label: string;
  type?: "text" | "number" | "date" | "time" | "datetime-local" | "textarea" | "select" | "checkbox";
  options?: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
  span?: boolean;
};

/**
 * Draft keeper.
 *
 * Typed answers are held outside React state as well as in it, keyed by the
 * form. A background refresh that rebuilds the screen underneath an open form
 * therefore cannot silently empty a date, a time or a follow-up the operator
 * has already entered — the form restores what was typed. A draft is dropped
 * the moment its record is saved.
 *
 * The store hangs off the page rather than this file so that two copies of the
 * module can never end up holding two different sets of answers.
 */
type DraftStore = Map<string, Record<string, unknown>>;
const draftHost = globalThis as unknown as { __neoFormDrafts?: DraftStore };
const formDrafts: DraftStore = (draftHost.__neoFormDrafts ??= new Map());

const draftSlot = (draftKey: string) => `neo-form-draft:${draftKey}`;

/** Drafts also survive a page refresh, so a half-typed enquiry is never lost. */
function readDraft(draftKey: string): Record<string, unknown> | undefined {
  const held = formDrafts.get(draftKey);
  if (held) return held;
  try {
    const raw = globalThis.sessionStorage?.getItem(draftSlot(draftKey));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    formDrafts.set(draftKey, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

function writeDraft(draftKey: string, values: Record<string, unknown>) {
  formDrafts.set(draftKey, values);
  try {
    globalThis.sessionStorage?.setItem(draftSlot(draftKey), JSON.stringify(values));
  } catch {
    /* a full or unavailable store must never block typing */
  }
}

export function clearFormDraft(draftKey: string) {
  formDrafts.delete(draftKey);
  try {
    globalThis.sessionStorage?.removeItem(draftSlot(draftKey));
  } catch {
    /* nothing to clear */
  }
}



export function RecordForm({
  fields,
  initial,
  submitLabel,
  onSubmit,
  busy,
  onValuesChange,
  draftKey,
  validate,
}: {
  fields: FieldSpec[];
  initial?: Record<string, unknown>;
  submitLabel: string;
  onSubmit: (values: Record<string, unknown>) => void;
  busy?: boolean;
  /** Lets a caller narrow dependent choices, e.g. invoices belonging to the chosen supplier. */
  onValuesChange?: (values: Record<string, unknown>) => void;
  /** Keeps typed answers through a re-render of the screen behind the form. */
  draftKey?: string;
  /** Returns a message when the record cannot yet be saved. */
  validate?: (values: Record<string, unknown>) => string | null;
}) {
  // Typed text, dates and times live in the fields themselves. Nothing React
  // does in the background — a refreshed list, a re-render caused by choosing
  // an event type — can therefore empty a date the operator already entered.
  // Choices (selects, checkboxes) are held in state because they have no
  // browser field of their own.
  const opening = (draftKey ? readDraft(draftKey) : undefined) ?? initial ?? {};
  const valuesRef = useRef<Record<string, unknown>>({ ...opening });
  const [choices, setChoices] = useState<Record<string, unknown>>({ ...opening });
  const [problem, setProblem] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  /** Everything currently on screen, fields first. */
  const readAll = (): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...valuesRef.current, ...choices };
    const form = formRef.current;
    if (form) {
      for (const f of fields) {
        if (f.type === "select" || f.type === "checkbox") continue;
        const el = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#f-${CSS.escape(f.name)}`);
        if (!el) continue;
        out[f.name] = f.type === "number" ? (el.value === "" ? "" : Number(el.value)) : el.value;
      }
    }
    return out;
  };

  const remember = () => {
    const all = readAll();
    valuesRef.current = all;
    if (draftKey) writeDraft(draftKey, all);
    onValuesChange?.(all);
  };

  const setChoice = (name: string, value: unknown) => {
    setProblem(null);
    setChoices((c) => ({ ...c, [name]: value }));
    valuesRef.current = { ...readAll(), [name]: value };
    if (draftKey) writeDraft(draftKey, valuesRef.current);
    onValuesChange?.(valuesRef.current);
  };

  useEffect(() => {
    onValuesChange?.(valuesRef.current);
    // Callers only need the latest answers; the callback identity is theirs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <form
      ref={formRef}
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const onScreen = readAll();
        const message = validate?.(onScreen) ?? null;
        setProblem(message);
        if (message) return;
        if (draftKey) clearFormDraft(draftKey);
        onSubmit(onScreen);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.name} className={cn("space-y-1.5", f.span && "sm:col-span-2")}>
            <Label htmlFor={`f-${f.name}`} className="text-xs text-muted-foreground">
              {f.label}
            </Label>
            {f.type === "textarea" ? (
              <Textarea
                id={`f-${f.name}`}
                defaultValue={String(opening[f.name] ?? "")}
                placeholder={f.placeholder ?? ""}
                required={f.required ?? false}
                onChange={() => {
                  setProblem(null);
                  remember();
                }}
              />
            ) : f.type === "select" ? (
              <Select value={String(choices[f.name] ?? "")} onValueChange={(v) => setChoice(f.name, v)}>
                <SelectTrigger id={`f-${f.name}`} className="h-9">
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {(f.options ?? []).map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : f.type === "checkbox" ? (
              <label className="flex h-9 items-center gap-2 text-sm">
                <input
                  id={`f-${f.name}`}
                  type="checkbox"
                  className="size-4 rounded border-border"
                  checked={Boolean(choices[f.name])}
                  onChange={(e) => setChoice(f.name, e.target.checked)}
                />
                <span className="text-muted-foreground">Yes</span>
              </label>
            ) : (
              <Input
                id={`f-${f.name}`}
                type={f.type ?? "text"}
                defaultValue={String(opening[f.name] ?? "")}
                placeholder={f.placeholder ?? ""}
                required={f.required ?? false}
                onChange={() => {
                  setProblem(null);
                  remember();
                }}
              />
            )}
          </div>
        ))}
      </div>
      {problem ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <Button type="submit" disabled={busy ?? false}>
        {submitLabel}
      </Button>
    </form>
  );
}

export function FormDialog({
  trigger,
  title,
  description,
  children,
  onOpenChange,
}: {
  trigger?: ReactNode;
  title: string;
  description: string;
  children: (close: () => void) => ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <Plus className="size-4" />
            {title}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children(() => setOpen(false))}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shared register table.
 *
 * Long finance and admin registers page themselves: paging is presentation
 * only — the same permitted rows are simply delivered a page at a time so a
 * four-thousand-row ledger cannot stretch its card or push the pager into the
 * rows (or the calendar) below it. The pager sits outside the table, and the
 * table keeps its own contained horizontal scroll on narrow screens.
 */
export function DataTable({
  head,
  children,
  pageSize = 25,
  unit = "records",
}: {
  head: string[];
  children: ReactNode;
  pageSize?: number;
  unit?: string;
}) {
  // Every cell carries the column it belongs to, so the same markup can read as
  // a table on a laptop and as a stacked label/value card on a phone. Nothing
  // is hidden on the small screen — the columns simply fold under each other.
  const rows = Children.toArray(children).map((row) => {
    if (!isValidElement(row)) return row;
    const props = row.props as { children?: ReactNode };
    let index = 0;
    const cells = Children.map(props.children, (cell) => {
      if (!isValidElement(cell)) return cell;
      const label = head[index] ?? "";
      index += 1;
      const cellProps = cell.props as Record<string, unknown>;
      if (cellProps["data-label"] !== undefined) return cell;
      return cloneElement(cell as ReactElement<Record<string, unknown>>, {
        "data-label": label,
      });
    });
    return cloneElement(row as ReactElement<{ children?: ReactNode }>, undefined, cells);
  });
  const pager = usePagedRows(rows, pageSize);
  const paged = rows.length > pageSize;

  return (
    <div className="min-w-0">
      <div className="neo-table-scroll overflow-x-auto">
        <table className="neo-stack-table w-full text-sm sm:min-w-[640px]">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              {head.map((h) => (
                <th key={h} className="whitespace-nowrap py-2 pr-4 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {paged ? pager.pageRows : rows}
          </tbody>
        </table>
      </div>
      {paged ? (
        <TablePager
          page={pager.page}
          totalPages={pager.totalPages}
          total={pager.total}
          from={pager.from}
          to={pager.to}
          pageSize={pager.pageSize}
          onPage={pager.setPage}
          onPageSize={pager.setPageSize}
          unit={unit}
        />
      ) : null}
    </div>
  );
}


/**
 * Conversion outcome cell.
 *
 * An enquiry or quotation converts exactly once. Once an event exists, the
 * screen shows that event and links to it; the convert control is withdrawn
 * because a second conversion is refused by the database and would only ever
 * produce a confusing error.
 */
export function ConvertedEvent({
  link,
  bookingId,
}: {
  link: { reference: string; status: string } | undefined;
  bookingId?: string;
}) {
  if (!link) return null;
  return (
    <div className="text-xs">
      <Link
        to="/events/bookings/$id"
        params={{ id: bookingId ?? "" }}
        className="font-medium text-primary underline-offset-4 hover:underline"
      >
        {link.reference || "Linked event"}
      </Link>
      <span className="block text-muted-foreground">Already converted · {titleCase(link.status)}</span>
    </div>
  );
}

/** Explains why a second conversion is not offered. */
export function ConversionBlocked({ reference }: { reference: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Converted once already — event {reference}. A second conversion is refused.
    </p>
  );
}
