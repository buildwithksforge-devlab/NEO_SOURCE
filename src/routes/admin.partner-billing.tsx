import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { useBranches } from "@/lib/branches";
import {
  useHotelPartnerSend,
  useHotelPartnerThreads,
  useRaisePartnerInvoice,
  type PartnerInvoiceLine,
} from "@/lib/partner-billing";

export const Route = createFileRoute("/admin/partner-billing")({
  head: () => ({
    meta: [
      { title: "Partner Billing — Configuration Centre" },
      {
        name: "description",
        content:
          "Raise a real credit invoice against a corporate partner's account, post it to the ledger and send it to the partner in their own Messages thread.",
      },
      { property: "og:title", content: "Partner Billing — Configuration Centre" },
      {
        property: "og:description",
        content: "Credit invoices and two-way messages with the businesses you work with.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PartnerBillingPage,
});

type AccessRow = {
  id: string;
  email: string;
  contact_name: string | null;
  relationship_type: string;
  status: string;
  supplier_name: string | null;
  corporate_name: string | null;
};

const emptyLine: PartnerInvoiceLine = { description: "", quantity: 1, unit_price: 0, tax_rate: 0 };

function PartnerBillingPage() {
  const { can } = useAuth();
  const mayInvoice = can("finance", "create") || can("administration", "workspace", "edit");
  const branches = useBranches();
  const [branchId, setBranchId] = useState<string | null>(null);
  const [relationship, setRelationship] = useState<string>("");

  useEffect(() => {
    if (!branchId && branches.data?.length) setBranchId(branches.data[0]!.id);
  }, [branches.data, branchId]);

  const partners = useQuery({
    queryKey: ["partner-billing-list", branchId],
    enabled: Boolean(branchId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_partner_access_list", {
        _branch: branchId,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as AccessRow[];
    },
  });

  const creditPartners = useMemo(
    () => (partners.data ?? []).filter((p) => p.status === "active" && p.corporate_name),
    [partners.data],
  );

  useEffect(() => {
    if (relationship && !creditPartners.some((p) => p.id === relationship)) setRelationship("");
  }, [creditPartners, relationship]);

  const active = relationship || null;
  const [lines, setLines] = useState<PartnerInvoiceLine[]>([{ ...emptyLine }]);
  const [due, setDue] = useState("");
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState("");
  const raise = useRaisePartnerInvoice(active);

  const total = lines.reduce((sum, l) => {
    const net = Number(l.quantity || 0) * Number(l.unit_price || 0);
    return sum + net + (net * Number(l.tax_rate || 0)) / 100;
  }, 0);

  const valid =
    Boolean(active) &&
    lines.length > 0 &&
    lines.every((l) => l.description.trim() && l.quantity > 0 && l.unit_price > 0);

  const setLine = (index: number, patch: Partial<PartnerInvoiceLine>) =>
    setLines((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Finance"
        title="Partner Billing"
        description="Bill a corporate partner on credit. The invoice is a real receivable — it is numbered, posted to the ledger as Accounts Receivable against revenue, written to the audit trail and delivered to the partner inside their own portal conversation."
      />

      <SectionCard title="Who are you billing?" description="Only partners with a corporate credit account on this property can be invoiced on credit.">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>Property</Label>
            <Select value={branchId ?? ""} onValueChange={(v) => setBranchId(v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select a property" />
              </SelectTrigger>
              <SelectContent>
                {(branches.data ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Partner</Label>
            <Select value={relationship} onValueChange={setRelationship}>
              <SelectTrigger>
                <SelectValue placeholder="Select a partner" />
              </SelectTrigger>
              <SelectContent>
                {creditPartners.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.corporate_name} — {p.contact_name ?? p.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {partners.isLoading ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading partners…
          </p>
        ) : creditPartners.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No partner on this property has an active corporate credit account yet. Set one up in
            Partner access first.
          </p>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Invoice lines"
        description="Type what you are charging. Nothing is pre-filled — the amounts posted are exactly the amounts entered here."
      >
        <div className="grid gap-3">
          {lines.map((line, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]">
              <Input
                aria-label={`Line ${index + 1} description`}
                placeholder="Description"
                value={line.description}
                onChange={(e) => setLine(index, { description: e.target.value })}
              />
              <Input
                aria-label={`Line ${index + 1} quantity`}
                type="number"
                min={0}
                placeholder="Qty"
                value={line.quantity}
                onChange={(e) => setLine(index, { quantity: Number(e.target.value) })}
              />
              <Input
                aria-label={`Line ${index + 1} unit price`}
                type="number"
                min={0}
                placeholder="Unit price"
                value={line.unit_price}
                onChange={(e) => setLine(index, { unit_price: Number(e.target.value) })}
              />
              <Input
                aria-label={`Line ${index + 1} tax rate`}
                type="number"
                min={0}
                placeholder="Tax %"
                value={line.tax_rate}
                onChange={(e) => setLine(index, { tax_rate: Number(e.target.value) })}
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={lines.length === 1}
                onClick={() => setLines((rows) => rows.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button variant="outline" size="sm" onClick={() => setLines((r) => [...r, { ...emptyLine }])}>
              Add line
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="pb-due">Due date</Label>
              <NeoDatePicker id="pb-due" value={due} onChange={(value) => setDue(value ?? "")} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pb-notes">Notes on the invoice</Label>
              <Input id="pb-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pb-message">Message to the partner</Label>
            <Textarea
              id="pb-message"
              value={message}
              placeholder="Leave empty to send the invoice number, amount and due date."
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Invoice total including tax: <strong>{total.toLocaleString()}</strong>
          </p>
          <div>
            <Button
              disabled={!valid || !mayInvoice || raise.isPending}
              onClick={() =>
                raise.mutate(
                  { lines, due: due || null, notes, message },
                  {
                    onSuccess: () => {
                      setLines([{ ...emptyLine }]);
                      setDue("");
                      setNotes("");
                      setMessage("");
                    },
                  },
                )
              }
            >
              {raise.isPending ? "Raising…" : "Raise and send invoice"}
            </Button>
          </div>
          {!mayInvoice ? (
            <p className="text-sm text-muted-foreground">
              Your role can view this screen but cannot raise invoices.
            </p>
          ) : null}
        </div>
      </SectionCard>

      <PartnerConversation relationshipId={active} />
    </div>
  );
}

function PartnerConversation({ relationshipId }: { relationshipId: string | null }) {
  const threads = useHotelPartnerThreads(relationshipId);
  const send = useHotelPartnerSend(relationshipId);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");

  const list = threads.data ?? [];
  const active = list.find((t) => t.id === openThread) ?? list[0] ?? null;

  return (
    <SectionCard
      title="Messages with this partner"
      description="The same conversation the partner sees in their portal. Invoices you raise appear here too."
    >
      {!relationshipId ? (
        <p className="text-sm text-muted-foreground">Select a partner to see the conversation.</p>
      ) : threads.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading messages…
        </p>
      ) : (
        <div className="grid gap-3">
          {list.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {list.map((t) => (
                <Button
                  key={t.id}
                  size="sm"
                  variant={active?.id === t.id ? "default" : "outline"}
                  onClick={() => setOpenThread(t.id)}
                >
                  {t.subject}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No conversation yet. Start one below and the partner will see it in their portal.
            </p>
          )}

          {active ? (
            <div className="grid gap-2">
              {active.messages.map((m) => (
                <div key={m.id} className="rounded-lg border p-3 text-sm">
                  <p className="text-xs text-muted-foreground">
                    {m.side === "hotel" ? "Hotel" : "Partner"} · {m.sender_name ?? "Not captured"} ·{" "}
                    {new Date(m.at).toLocaleString()}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
                </div>
              ))}
            </div>
          ) : null}

          {!active ? (
            <Input
              placeholder="Subject"
              value={subject}
              aria-label="Conversation subject"
              onChange={(e) => setSubject(e.target.value)}
            />
          ) : null}
          <Textarea
            placeholder={active ? `Reply in ${active.subject}` : "Write your message"}
            value={body}
            aria-label="Message to the partner"
            onChange={(e) => setBody(e.target.value)}
          />
          <div>
            <Button
              disabled={!body.trim() || send.isPending}
              onClick={() =>
                send.mutate(
                  {
                    body,
                    threadId: active?.id ?? null,
                    ...(active ? {} : { subject: subject.trim() || "Message from the hotel" }),
                  },
                  { onSuccess: () => setBody("") },
                )
              }
            >
              {send.isPending ? "Sending…" : active ? "Send reply" : "Start conversation"}
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
