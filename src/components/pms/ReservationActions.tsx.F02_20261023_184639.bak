import { useState, type ReactNode } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { depositGate, useDepositPosition } from "@/lib/deposits";
import { DepositPanel } from "@/components/pms/DepositPanel";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useMyOpenShift } from "@/lib/pos-data";
import { useOpenCashShift } from "@/lib/frontdesk-ops";
import {
  useFolioCashRequests,
  useRequestCashPayment,
  useTillContext,
} from "@/lib/cash-routing";
import { PaymentMethodPicker } from "@/components/payments/PaymentMethodPicker";

import {
  FOLIO_CATEGORIES,
  PAYMENT_METHODS,
  money,
  titleCase,
  today,
} from "@/lib/pms";
import {
  useAssignRoom,
  useAvailability,
  useCheckIn,
  useCheckOut,
  usePostCharge,
  useReceivingAccounts,
  useRecordPayment,
  useTransferRoom,
} from "@/lib/pms-data";

type Reservation = {
  id: string;
  confirmation_number: string;
  room_id: string | null;
  room_type_id: string | null;
  arrival_date: string;
  departure_date: string;
  adults: number;
  children: number;
  branch_id: string | null;
};

function ActionDialog({
  trigger,
  title,
  description,
  children,
  onConfirm,
  confirmLabel,
  disabled,
  open,
  setOpen,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
  onConfirm: () => void | Promise<unknown>;
  confirmLabel: string;
  disabled?: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">{children}</div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={disabled}
            onClick={async () => {
              await onConfirm();
              setOpen(false);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Assign or change the physical room from live availability. */
export function AssignRoomDialog({
  reservation,
  label = "Assign room",
  transfer = false,
}: {
  reservation: Reservation;
  label?: string;
  transfer?: boolean;
}) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [room, setRoom] = useState("");
  const [reason, setReason] = useState("");
  const [moveType, setMoveType] = useState("transfer");
  const assign = useAssignRoom();
  const move = useTransferRoom();

  const availability = useAvailability({
    branch: reservation.branch_id,
    arrival: reservation.arrival_date,
    departure: reservation.departure_date,
    roomType: transfer ? null : reservation.room_type_id,
    adults: reservation.adults,
    children: reservation.children,
    enabled: open,
  });

  // The same availability engine, asked without the room-type filter. The
  // Availability screen shows the property's sellable rooms; the assignment
  // dialog narrowed to the booked room type and then reported "no room free",
  // which reads as a disagreement between two screens. When the booked type
  // has nothing, the free rooms of other types are offered explicitly.
  const anyType = useAvailability({
    branch: reservation.branch_id,
    arrival: reservation.arrival_date,
    departure: reservation.departure_date,
    roomType: null,
    adults: reservation.adults,
    children: reservation.children,
    enabled: open && !transfer,
  });

  const typedRooms = availability.data ?? [];
  const otherRooms = transfer ? [] : (anyType.data ?? []);
  const rooms = typedRooms.length > 0 ? typedRooms : otherRooms;
  const offeringOtherTypes = typedRooms.length === 0 && otherRooms.length > 0;
  const checking = availability.isLoading || (!transfer && anyType.isLoading);

  const permitted = can("pms", transfer ? "in-house.edit" : "arrivals.edit");
  if (!permitted) return null;

  return (
    <ActionDialog
      open={open}
      setOpen={setOpen}
      trigger={
        <Button variant="outline" size="sm">
          {label}
        </Button>
      }
      title={transfer ? "Move guest to another room" : "Assign room"}
      description={
        transfer
          ? "The folio, charges and stay history follow the guest. The vacated room is sent for cleaning."
          : "Only rooms that are free, sellable and large enough for the party are listed."
      }
      confirmLabel={transfer ? "Move guest" : "Assign"}
      disabled={!room || (transfer && !reason.trim())}
      onConfirm={() =>
        transfer
          ? move.mutateAsync({ reservation: reservation.id, toRoom: room, reason, moveType })
          : assign.mutateAsync({ reservation: reservation.id, room, reason })
      }
    >
      <div className="space-y-2">
        <Label>Available rooms</Label>
        {checking ? (
          <p className="text-sm text-muted-foreground">Checking availability…</p>
        ) : rooms.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No room is free for {reservation.arrival_date} → {reservation.departure_date}. Add rooms, release a block
            or use the waitlist.
          </p>
        ) : (
          <>
            {offeringOtherTypes ? (
              <p className="text-sm text-muted-foreground">
                No room of the booked type is free for these dates. The rooms below are free at this property
                on other room types — assigning one changes the room type on the stay.
              </p>
            ) : null}
            <Select value={room} onValueChange={setRoom}>
              <SelectTrigger>
                <SelectValue placeholder="Select a room" />
              </SelectTrigger>
              <SelectContent>
                {rooms.map((r) => (
                  <SelectItem key={r.room_id} value={r.room_id}>
                    {r.room_number} · {r.room_type_name}
                    {r.floor ? ` · Floor ${r.floor}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
      </div>
      {transfer ? (
        <div className="space-y-2">
          <Label>Move type</Label>
          <Select value={moveType} onValueChange={setMoveType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["transfer", "upgrade", "downgrade", "maintenance", "guest-request"].map((t) => (
                <SelectItem key={t} value={t}>
                  {titleCase(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="space-y-2">
        <Label>Reason {transfer ? "(required)" : "(optional)"}</Label>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      </div>
    </ActionDialog>
  );
}

export function CheckInDialog({ reservation }: { reservation: Reservation }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState(1);
  const [notes, setNotes] = useState("");
  const [idVerified, setIdVerified] = useState(false);
  const checkIn = useCheckIn();
  const deposit = useDepositPosition(reservation.id, open);
  const gate = depositGate(deposit.data);

  if (!can("pms", "arrivals.edit")) return null;

  return (
    <ActionDialog
      open={open}
      setOpen={setOpen}
      trigger={<Button size="sm">Check in</Button>}
      title={`Check in ${reservation.confirmation_number}`}
      description="Opens the guest folio, marks the room occupied and notifies housekeeping."
      confirmLabel="Complete check-in"
      disabled={!reservation.room_id || !idVerified || gate.blocked || deposit.isLoading}
      onConfirm={() => checkIn.mutateAsync({ reservation: reservation.id, keys, notes })}
    >
      {!reservation.room_id ? (
        <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          Assign a room before checking this guest in.
        </p>
      ) : null}
      {gate.blocked ? (
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <p>{gate.message}</p>
          <p className="text-xs text-muted-foreground">
            Record the deposit or authorise an override on the reservation before checking in.
          </p>
        </div>
      ) : null}
      <DepositPanel reservationId={reservation.id} />
      <div className="flex items-center justify-between rounded-lg border border-border/70 p-3">
        <div>
          <p className="text-sm font-medium">Identity document sighted</p>
          <p className="text-xs text-muted-foreground">Recorded on the registration card.</p>
        </div>
        <Switch checked={idVerified} onCheckedChange={setIdVerified} />
      </div>
      <div className="space-y-2">
        <Label>Keys issued</Label>
        <Input type="number" min={0} value={keys} onChange={(e) => setKeys(Number(e.target.value))} />
      </div>
      <div className="space-y-2">
        <Label>Check-in notes</Label>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </div>
    </ActionDialog>
  );
}

export function CheckOutDialog({
  reservation,
  balance,
}: {
  reservation: Reservation;
  balance: number;
}) {
  const { can, isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const [force, setForce] = useState(false);
  const [notes, setNotes] = useState("");
  const checkOut = useCheckOut();

  if (!can("pms", "departures.edit")) return null;
  const outstanding = balance > 0.009;

  return (
    <ActionDialog
      open={open}
      setOpen={setOpen}
      trigger={<Button size="sm">Check out</Button>}
      title={`Check out ${reservation.confirmation_number}`}
      description="Settles the stay, releases the room for cleaning and closes the folio."
      confirmLabel="Complete check-out"
      disabled={outstanding && !force}
      onConfirm={() => checkOut.mutateAsync({ reservation: reservation.id, force, notes })}
    >
      <div className="rounded-lg border border-border/70 p-3 text-sm">
        <span className="text-muted-foreground">Folio balance</span>
        <p className={outstanding ? "text-lg font-semibold text-destructive" : "text-lg font-semibold text-success"}>
          {money(balance)}
        </p>
      </div>
      {outstanding ? (
        <div className="flex items-center justify-between rounded-lg border border-warning/40 bg-warning/10 p-3">
          <div>
            <p className="text-sm font-medium">Check out with an outstanding balance</p>
            <p className="text-xs text-muted-foreground">
              {isAdmin ? "Requires an authorised override and is written to the audit trail." : "Only authorised staff may override."}
            </p>
          </div>
          <Switch checked={force} onCheckedChange={setForce} disabled={!isAdmin} />
        </div>
      ) : null}
      <div className="space-y-2">
        <Label>Check-out notes</Label>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </div>
    </ActionDialog>
  );
}

export function PostChargeDialog({ folioId }: { folioId: string }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<string>("miscellaneous");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [unitPrice, setUnitPrice] = useState(0);
  const [tax, setTax] = useState(0);
  const post = usePostCharge();

  if (!can("pms", "folios.create")) return null;

  return (
    <ActionDialog
      open={open}
      setOpen={setOpen}
      trigger={
        <Button variant="outline" size="sm">
          Post charge
        </Button>
      }
      title="Post a charge"
      description="Charges are posted once — a duplicate submission is ignored by the posting service."
      confirmLabel="Post charge"
      disabled={!description.trim() || unitPrice <= 0}
      onConfirm={() =>
        post.mutateAsync({ folio: folioId, category, description, quantity, unitPrice, tax })
      }
    >
      <div className="space-y-2">
        <Label>Category</Label>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FOLIO_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {titleCase(c)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Description</Label>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-2">
          <Label>Qty</Label>
          <Input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} />
        </div>
        <div className="space-y-2">
          <Label>Unit price</Label>
          <Input type="number" min={0} value={unitPrice} onChange={(e) => setUnitPrice(Number(e.target.value))} />
        </div>
        <div className="space-y-2">
          <Label>Tax</Label>
          <Input type="number" min={0} value={tax} onChange={(e) => setTax(Number(e.target.value))} />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Net amount <span className="font-semibold text-foreground">{money(quantity * unitPrice + tax)}</span>
      </p>
    </ActionDialog>
  );
}

export function RecordPaymentDialog({ folioId, balance }: { folioId: string; balance: number }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(balance > 0 ? balance : 0);
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [float, setFloat] = useState("");
  const [account, setAccount] = useState<string>("");
  const pay = useRecordPayment();
  const accounts = useReceivingAccounts();
  // One collection intent per opening of this dialog: retries settle the same
  // receipt, while a genuine second payment of the same amount still goes through.
  const [intentKey, setIntentKey] = useState(() => crypto.randomUUID());
  const myShift = useMyOpenShift();
  const openShift = useOpenCashShift();
  const { branchId } = useActivePropertyFilter();
  const till = useTillContext(branchId);
  const requestCash = useRequestCashPayment();
  const folioRequests = useFolioCashRequests(open ? folioId : null);

  if (!can("pms", "folios.edit")) return null;
  const selected = PAYMENT_METHODS.find((m) => m.value === method);
  const isCash = method === "cash";
  const ctx = till.data;
  // Billing and cash handling are separate acts: a user holding their own till
  // settles directly, everyone else routes the cash to an active drawer.
  const selfService = Boolean(ctx?.self_service);
  const routedTill = ctx?.active_tills?.[0] ?? null;
  const noTill = isCash && !till.isLoading && !selfService && !routedTill;
  const mayOpenDrawer = Boolean(ctx?.can_open_drawer);
  const pendingHere = (folioRequests.data ?? []).filter((r) => r.status === "pending");

  return (
    <ActionDialog
      open={open}
      setOpen={(next) => {
        if (next) setIntentKey(crypto.randomUUID());
        setOpen(next);
      }}
      trigger={<Button size="sm">Record payment</Button>}
      title={isCash ? "Take a cash payment" : "Record a payment"}
      description={
        isCash
          ? selfService
            ? "Confirms cash physically received into your own till and produces a numbered receipt."
            : "Routes the cash to an authorised cashier, who confirms the money was physically received."
          : "Produces a numbered receipt and reduces the folio balance."
      }
      confirmLabel={isCash ? (selfService ? "Confirm cash received" : "Send to cashier") : "Record payment"}
      disabled={amount <= 0 || !selected || noTill || requestCash.isPending || pay.isPending}
      onConfirm={() =>
        isCash
          ? requestCash.mutateAsync({ folio: folioId, amount, reference, notes })
          : pay.mutateAsync({
              folio: folioId,
              amount,
              method,
              reference,
              notes,
              intentKey,
              account: account || null,
            })
      }
    >
      <div className="space-y-2">
        <Label>Amount</Label>
        <Input type="number" min={0} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
        <p className="text-xs text-muted-foreground">Outstanding balance {money(balance)}</p>
      </div>
      {isCash && !selfService && routedTill ? (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          Cash will be routed to <span className="font-medium text-foreground">{routedTill.cashier_name}</span> on till{" "}
          {routedTill.shift_number ?? routedTill.shift_id.slice(0, 8)}. The folio settles only when that cashier
          confirms the money in hand.
        </p>
      ) : null}
      {pendingHere.length ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-on-tint-warning">
          {pendingHere.length} cash {pendingHere.length === 1 ? "request is" : "requests are"} already awaiting
          confirmation on this folio.
        </p>
      ) : null}
      {noTill ? (
        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="text-xs text-on-tint-warning">
            No active cash drawer is open for this outlet. {mayOpenDrawer
              ? "Count your opening float and open your till to continue."
              : "Ask a cashier or supervisor with drawer authority to open one for this outlet."}
          </p>
          {mayOpenDrawer ? (
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label>Opening float</Label>
                <Input type="number" min={0} value={float} onChange={(e) => setFloat(e.target.value)} />
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={openShift.isPending || float === ""}
                onClick={async () => {
                  await openShift.mutateAsync({ branch: branchId, station: null, float: Number(float) });
                  await myShift.refetch();
                  await till.refetch();
                }}
              >
                Open drawer
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}


      <div className="space-y-2">
        <PaymentMethodPicker methods={PAYMENT_METHODS} value={method} onChange={setMethod} />
        {selected?.provider === "mpesa" ? (
          <p className="text-xs text-muted-foreground">
            This records money the customer has already sent. To ask the customer's phone for the payment, use the
            M-Pesa prompt on the folio instead.
          </p>
        ) : null}

      </div>
      {!isCash ? (
        <div className="space-y-2">
          <Label>Money received into</Label>
          <Select value={account} onValueChange={setAccount}>
            <SelectTrigger>
              <SelectValue placeholder="Use the default account for this method" />
            </SelectTrigger>
            <SelectContent>
              {(accounts.data ?? []).map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                  {a.account_kind ? ` · ${titleCase(a.account_kind.replace(/[-_]/g, " "))}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {accounts.data?.length
              ? "Choose the bank, card or mobile-money account the money landed in. Leave it unset to use the default for this method."
              : "No receiving accounts are set up yet, so the default account for this method is used."}
          </p>
        </div>
      ) : null}
      <div className="space-y-2">
        <Label>Reference</Label>
        <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Receipt / transaction reference" />
      </div>
      <div className="space-y-2">
        <Label>Notes</Label>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </div>
    </ActionDialog>
  );
}

export const operationalToday = today;
