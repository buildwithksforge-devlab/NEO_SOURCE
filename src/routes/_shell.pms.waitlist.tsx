import { useState } from "react";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { createFileRoute } from "@tanstack/react-router";
import { CalendarRange, Plus } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, PmsGuard, QueryState } from "@/components/pms/PmsShared";
import { WAITLIST_STATUSES, formatDateTime, money, nightsBetween, titleCase } from "@/lib/pms";
import { useRoomTypes, useWaitlist } from "@/lib/pms-data";
import { parseAvailabilitySearch } from "@/lib/availability-search";
import { useCloseWaitlist, useConvertWaitlist, useCreateWaitlistEntry, useOfferWaitlist } from "@/lib/frontdesk-ops";

export const Route = createFileRoute("/_shell/pms/waitlist")({
  // Carries the searched dates, occupancy and room type from Availability.
  validateSearch: parseAvailabilitySearch,
  head: () => ({
    meta: [
      { title: "Reservation Waitlist — NEØ" },
      {
        name: "description",
        content:
          "Unmet demand with priority, requested dates, offers, expiry and conversion history.",
      },
      { property: "og:title", content: "Reservation Waitlist — NEØ" },
      {
        property: "og:description",
        content:
          "Unmet demand with priority, requested dates, offers, expiry and conversion history.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="waitlist.view">
      <WaitlistPage />
    </PmsGuard>
  ),
});

type Entry = { id: string; quoted_rate: number | null; contact_name: string | null };

function WaitlistPage() {
  const search = Route.useSearch();
  const [status, setStatus] = useState("waiting");
  const waitlist = useWaitlist(status);
  const roomTypes = useRoomTypes();
  const createEntry = useCreateWaitlistEntry();
  const rows = waitlist.data ?? [];
  const convert = useConvertWaitlist();
  const [offering, setOffering] = useState<Entry | null>(null);
  const [closing, setClosing] = useState<Entry | null>(null);
  const [creating, setCreating] = useState(false);
  const [newEntry, setNewEntry] = useState({
    contactName: "", contactPhone: "", contactEmail: "",
    arrival: search.arrival ?? "", departure: search.departure ?? "",
    roomTypeId: search.roomType === "all" ? "" : search.roomType,
    adults: String(search.adults), children: String(search.children), priority: "normal", notes: "",
  });

  return (
    <div>
      <PageHeader
        eyebrow="Front Office"
        title="Reservation Waitlist"
        description="Demand the property could not confirm yet. Every entry can be offered a rate, converted into a reservation, or closed with a recorded reason."
        actions={
          <div className="flex flex-wrap gap-2">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-52" aria-label="Filter waitlist by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {WAITLIST_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{titleCase(s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => setCreating(true)}><Plus className="mr-2 size-4" /> Add to waitlist</Button>
          </div>
        }
      />

      <SectionCard
        title={`${rows.length} waitlist entr(ies)`}
        description="Ordered by requested arrival date."
      >
        <QueryState
          isLoading={waitlist.isLoading}
          error={waitlist.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={CalendarRange}
              title="Nobody is waiting"
              description="When availability is refused during booking, the enquiry can be placed on the waitlist and will appear here."
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Guest</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead>Nights</TableHead>
                  <TableHead>Room type</TableHead>
                  <TableHead>Quoted</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Offer expires</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((w) => {
                  const entry: Entry = {
                    id: w.id,
                    quoted_rate: w.quoted_rate,
                    contact_name: w.contact_name,
                  };
                  const closed = !["waiting", "offered"].includes(w.status);
                  return (
                    <TableRow key={w.id}>
                      <TableCell className="font-medium">
                        {w.customers?.full_name ?? w.contact_name ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {w.contact_phone ??
                          w.customers?.phone ??
                          w.contact_email ??
                          w.customers?.email ??
                          "—"}
                      </TableCell>
                      <TableCell>
                        {w.arrival_date} → {w.departure_date}
                      </TableCell>
                      <TableCell>{nightsBetween(w.arrival_date, w.departure_date)}</TableCell>
                      <TableCell>{w.room_types?.name ?? "Any"}</TableCell>
                      <TableCell>{w.quoted_rate ? money(w.quoted_rate) : "—"}</TableCell>
                      <TableCell>{titleCase(w.priority)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDateTime(w.offer_expires_at)}
                      </TableCell>
                      <TableCell>
                        <StatusPill
                          tone={
                            w.status === "converted"
                              ? "success"
                              : w.status === "offered"
                                ? "info"
                                : closed
                                  ? "warning"
                                  : "default"
                          }
                        >
                          {titleCase(w.status)}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="space-x-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={closed}
                          onClick={() => setOffering(entry)}
                        >
                          Offer
                        </Button>
                        <Button
                          size="sm"
                          disabled={closed || convert.isPending}
                          onClick={() => convert.mutate({ entry: w.id })}
                        >
                          Convert
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={closed}
                          onClick={() => setClosing(entry)}
                        >
                          Close
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </QueryState>
      </SectionCard>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add to waitlist</DialogTitle>
            <DialogDescription>Record unmet demand now so it can later be offered a room or converted into a reservation.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><Label>Guest/contact name</Label><Input value={newEntry.contactName} onChange={(e) => setNewEntry({ ...newEntry, contactName: e.target.value })} /></div>
            <div><Label>Phone</Label><Input value={newEntry.contactPhone} onChange={(e) => setNewEntry({ ...newEntry, contactPhone: e.target.value })} /></div>
            <div><Label>Email</Label><Input type="email" value={newEntry.contactEmail} onChange={(e) => setNewEntry({ ...newEntry, contactEmail: e.target.value })} /></div>
            <div><Label>Arrival</Label><NeoDatePicker value={newEntry.arrival} ariaLabel="Arrival date" onChange={(value) => setNewEntry({ ...newEntry, arrival: value })} /></div>
            <div><Label>Departure</Label><NeoDatePicker value={newEntry.departure} ariaLabel="Departure date" onChange={(value) => setNewEntry({ ...newEntry, departure: value })} /></div>
            <div className="sm:col-span-2"><Label>Room type</Label><Select value={newEntry.roomTypeId || "any"} onValueChange={(v) => setNewEntry({ ...newEntry, roomTypeId: v === "any" ? "" : v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="any">Any room type</SelectItem>{(roomTypes.data ?? []).map((rt) => <SelectItem key={rt.id} value={rt.id}>{rt.name}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>Adults</Label><Input type="number" min={1} value={newEntry.adults} onChange={(e) => setNewEntry({ ...newEntry, adults: e.target.value })} /></div>
            <div><Label>Children</Label><Input type="number" min={0} value={newEntry.children} onChange={(e) => setNewEntry({ ...newEntry, children: e.target.value })} /></div>
            <div className="sm:col-span-2"><Label>Notes</Label><Textarea value={newEntry.notes} onChange={(e) => setNewEntry({ ...newEntry, notes: e.target.value })} /></div>
          </div>
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button><Button disabled={createEntry.isPending || !newEntry.contactName.trim()} onClick={() => createEntry.mutate({ contactName: newEntry.contactName, contactPhone: newEntry.contactPhone, contactEmail: newEntry.contactEmail, arrival: newEntry.arrival, departure: newEntry.departure, roomTypeId: newEntry.roomTypeId || null, adults: Number(newEntry.adults) || 1, children: Number(newEntry.children) || 0, priority: newEntry.priority, ...(newEntry.notes ? { notes: newEntry.notes } : {}) }, { onSuccess: () => setCreating(false) })}>Add to waitlist</Button></div>
        </DialogContent>
      </Dialog>

      <OfferDialog entry={offering} onClose={() => setOffering(null)} />
      <CloseDialog entry={closing} onClose={() => setClosing(null)} />
    </div>
  );
}

function OfferDialog({ entry, onClose }: { entry: Entry | null; onClose: () => void }) {
  const offer = useOfferWaitlist();
  const [rate, setRate] = useState("");
  const [expires, setExpires] = useState("");

  return (
    <Dialog open={Boolean(entry)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Offer availability</DialogTitle>
          <DialogDescription>
            The guest is told a rate and given a deadline to accept before the room is released.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="offer-rate">Quoted nightly rate</Label>
            <Input
              id="offer-rate"
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="offer-expiry">Offer expires</Label>
            <Input
              id="offer-expiry"
              type="datetime-local"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
          </div>
          <Button
            disabled={offer.isPending}
            onClick={() => {
              offer.mutate(
                {
                  entry: entry!.id,
                  rate: rate ? Number(rate) : null,
                  expires: expires ? new Date(expires).toISOString() : null,
                },
                { onSuccess: onClose },
              );
            }}
          >
            Record offer
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CloseDialog({ entry, onClose }: { entry: Entry | null; onClose: () => void }) {
  const close = useCloseWaitlist();
  const [status, setStatus] = useState("cancelled");
  const [reason, setReason] = useState("");

  return (
    <Dialog open={Boolean(entry)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close waitlist entry</DialogTitle>
          <DialogDescription>
            Nothing is deleted — the entry stays on record with the reason it was closed.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Outcome</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cancelled">Cancelled by guest</SelectItem>
                <SelectItem value="declined">Offer declined</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="close-reason">Reason</Label>
            <Textarea
              id="close-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button
            disabled={reason.trim().length < 3 || close.isPending}
            onClick={() =>
              close.mutate({ entry: entry!.id, status, reason }, { onSuccess: onClose })
            }
          >
            Close entry
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
