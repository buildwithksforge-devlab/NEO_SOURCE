import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { FileText, Handshake, Loader2, MessageSquareText, PackageCheck, Search, ShoppingBag } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { usePartnerCreditInvoices } from "@/lib/partner-billing";
import {
  usePartnerThreads,
  useSendPartnerMessage,
  type PartnerThread,
} from "@/lib/partner-messaging";
import { fetchPropertyForVisitor, type PublicProperty } from "@/lib/front-door";
import { BrandMark, PoweredByNeo } from "@/components/public/PublicAppShell";
import { brandFallback } from "@/lib/public-apps";
import { normalizedHex, primaryInk } from "@/lib/public-palette";
import { brandStyle } from "@/lib/experience-brand";
import { PullToRefresh } from "@/components/common/PullToRefresh";
import { useNeoSignOut, useNeoSwitchAccount } from "@/lib/session-exit";
import { useAuth } from "@/lib/auth";
import { Display, PublicSurface, PublicTopBar } from "@/components/public/NeoPublic";
import { useTrackEntry } from "@/lib/traffic";
import { useCustomerSession } from "@/lib/public-session";
import { exportPartnerPurchaseOrder } from "@/lib/document-pdf.functions";
import { downloadDocumentPdf } from "@/lib/browser-document";
import { SupplierRfqs } from "@/components/partner/SupplierRfqs";
import { SupplierLpoResponses } from "@/components/partner/SupplierLpoResponses";
import { SupplierInvoiceSubmissions } from "@/components/partner/SupplierInvoiceSubmissions";

export const Route = createFileRoute("/partner/$propertySlug")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { section?: PartnerSection; relationship?: string } => {
    const section = SECTIONS.find((item) => item.key === search["section"])?.key;
    const relationship = typeof search["relationship"] === "string" &&
      /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(search["relationship"]) ? search["relationship"] : undefined;
    return { ...(section ? { section } : {}), ...(relationship ? { relationship } : {}) };
  },
  head: () => ({
    meta: [
      { title: "Partner portal — NEØ" },
      {
        name: "description",
        content:
          "Private portal for businesses working with this hotel: orders, deliveries, invoices and account details.",
      },
      { property: "og:title", content: "Partner portal — NEØ" },
      {
        property: "og:description",
        content: "Your business relationship with this hotel, in one place.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PartnerPortal,
});

type Relationship = {
  id: string;
  relationship_type: string;
  display_name: string | null;
  supplier_id: string | null;
  corporate_account_id: string | null;
};

type PartnerContext =
  | { allowed: true; organization_id: string; branch_id: string; relationships: Relationship[] }
  | { allowed: false; reason: string };

type PartnerRecords = {
  allowed: boolean;
  reason?: string;
  relationship_type?: string;
  purchase_orders?: Record<string, unknown>[];
  deliveries?: Record<string, unknown>[];
  invoices?: Record<string, unknown>[];
  corporate_account?: Record<string, unknown> | null;
};

type PartnerSection = "overview" | "requests" | "orders" | "deliveries" | "invoices" | "messages";

const SECTIONS: { key: PartnerSection; label: string; icon: typeof Handshake }[] = [
  { key: "overview", label: "Overview", icon: Handshake },
  { key: "requests", label: "Quote requests", icon: Search },
  { key: "orders", label: "Orders", icon: ShoppingBag },
  { key: "deliveries", label: "Deliveries", icon: PackageCheck },
  { key: "invoices", label: "Invoices", icon: FileText },
  { key: "messages", label: "Messages", icon: MessageSquareText },
];

const refusal: Record<string, string> = {
  not_signed_in: "Please sign in with the account the hotel authorised.",
  unknown_property: "This hotel address is not available.",
  no_relationship:
    "Your account has not been given partner access to this hotel. The hotel grants this from their own system.",
};

function PartnerPortal() {
  const { propertySlug } = Route.useParams();
  useTrackEntry(propertySlug, "partner");
  const [messageSubject, setMessageSubject] = useState("");
  const [downloadingOrder, setDownloadingOrder] = useState<string | null>(null);
  const exportOrder = useServerFn(exportPartnerPurchaseOrder);
  const { section = "overview", relationship: selected } = Route.useSearch();
  const navigate = Route.useNavigate();
  const setSection = (next: PartnerSection) => void navigate({ search: (prev) => ({ ...prev, section: next }) });
  const { user, loading: sessionLoading } = useCustomerSession();


  const property = useQuery({
    queryKey: ["neo-visitor-property", propertySlug, user?.id],
    enabled: !sessionLoading,
    queryFn: () => fetchPropertyForVisitor(propertySlug),
    staleTime: 60_000,
  });

  const branchId = property.data?.branch_id ?? null;

  const context = useQuery({
    queryKey: ["neo-partner-context", branchId, user?.id],
    enabled: Boolean(branchId && user),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_partner_context", {
        _branch: branchId,
      });
      if (error) throw new Error(error.message);
      return data as unknown as PartnerContext;
    },
  });

  const relationships = context.data?.allowed ? context.data.relationships : [];
  const active = relationships.find((relationship) => relationship.id === selected)?.id ?? relationships[0]?.id ?? null;
  async function downloadOrder(number: string) {
    if (!branchId || !active || downloadingOrder) return;
    setDownloadingOrder(number);
    try {
      const result = await exportOrder({ data: { branch: branchId, relationship: active, number } });
      const bytes = Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0));
      downloadDocumentPdf(new Blob([bytes], { type: "application/pdf" }), result.filename);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The purchase order could not be downloaded.");
    } finally {
      setDownloadingOrder(null);
    }
  }

  const records = useQuery({
    queryKey: ["neo-partner-records", branchId, active, user?.id],
    enabled: Boolean(branchId && active && user),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_partner_records", {
        _branch: branchId,
        _relationship: active,
      });
      if (error) throw new Error(error.message);
      return data as unknown as PartnerRecords;
    },
  });

  if (property.isLoading || sessionLoading || context.isLoading) {
    return (
      <Shell title="Partner portal">
        <div className="flex items-center gap-2 text-sm text-white/70">
          <Loader2 className="size-4 animate-spin" /> Checking your access…
        </div>
      </Shell>
    );
  }

  if (property.isError || context.isError) {
    return (
      <Shell title={property.data?.property_name ?? "Partner portal"} property={property.data}>
        <Panel>
          <p role="alert" className="text-sm text-white/85">Partner access couldn’t be checked.</p>
          <button className="neo-commerce-primary mt-4" onClick={() => {
            if (property.isError) void property.refetch();
            if (context.isError) void context.refetch();
          }}>Retry</button>
        </Panel>
      </Shell>
    );
  }

  if (!property.data) {
    return (
      <Shell title="Partner portal">
        <Panel>
          <p className="text-sm text-white/70">{refusal["unknown_property"]}</p>
        </Panel>
      </Shell>
    );
  }

  if (!context.data?.allowed) {
    const reason =
      !user
        ? "not_signed_in"
        : context.data && !context.data.allowed
          ? context.data.reason
          : "no_relationship";
    return (
      <Shell title={property.data.property_name} property={property.data}>
        <Panel>
          <h2 className="text-base font-semibold text-white">Partner access not available</h2>
          <p className="mt-2 text-sm text-white/70">{refusal[reason] ?? refusal["no_relationship"]}</p>
          {reason === "not_signed_in" ? (
            <Link
              to="/auth"
              search={{ redirect: `/partner/${encodeURIComponent(propertySlug)}` }}
              className="mt-4 inline-block rounded-xl bg-white px-4 py-2 text-sm font-semibold text-[#020A1C]"
            >
              Partner sign in
            </Link>
          ) : null}
          <Link
            to="/start/$propertySlug"
            params={{ propertySlug }}
            className="mt-4 inline-block text-sm font-semibold text-white underline"
          >
            Back to this hotel
          </Link>
        </Panel>
      </Shell>
    );
  }

  const data = !records.isError && records.data?.allowed ? records.data : undefined;
  const currency = property.data.currency;
  const askAbout = (subject: string) => {
    setMessageSubject(subject);
    setSection("messages");
  };

  return (
    <Shell title={property.data.property_name} property={property.data} section={section} onSection={setSection} isSupplier={Boolean(relationships.find((rel) => rel.id === active)?.supplier_id)}>
      {section === "overview" ? (
        <section className="neo-partner-hero mt-4">
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-white/12 text-white"><Handshake className="size-5" aria-hidden /></span>
          <div className="min-w-0">
            <h2 className="text-2xl font-bold text-white">Partner workspace</h2>
            <p className="mt-2 text-sm text-white/75">Follow your orders, deliveries, invoices and messages with {property.data.property_name}.</p>
          </div>
        </section>
      ) : null}

      {relationships.length > 1 ? (
        <div className="my-4 flex flex-wrap gap-2">
          {relationships.map((rel) => (
            <button
              key={rel.id}
              type="button"
              aria-pressed={rel.id === active}
              onClick={() => {
                setMessageSubject("");
                void navigate({ search: (prev) => ({ ...prev, relationship: rel.id }) });
              }}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
                rel.id === active ? "bg-white text-[#020A1C]" : "bg-white/10 text-white/70"
              }`}
            >
              {rel.display_name ?? rel.relationship_type}
            </button>
          ))}
        </div>
      ) : (
        <p className="my-4 text-sm text-white/70">
          {relationships[0]?.display_name ?? "Your business"} ·{" "}
          {relationships[0]?.relationship_type.replace(/_/g, " ")}
        </p>
      )}

      {records.isLoading ? (
        <div role="status" className="flex items-center gap-2 text-sm text-white/70">
          <Loader2 className="size-4 animate-spin" /> Loading your records…
        </div>
      ) : records.isError || records.data?.allowed === false ? (
        <Panel>
          <p role="alert" className="text-sm text-white">
            {records.isError ? "Your partner records could not load." : refusal[records.data?.reason ?? ""] ?? refusal["no_relationship"]}
          </p>
          <button type="button" className="neo-commerce-primary mt-4" onClick={() => {
            void records.refetch();
            void context.refetch();
          }}>Try again</button>
        </Panel>
      ) : null}
      {records.error ? (
        <Panel><p role="alert" className="text-sm text-white/80">Could not load this relationship: {records.error.message}</p></Panel>
      ) : null}

      {section === "overview" ? (
        <>
          {data?.corporate_account ? (
            <Panel>
              <h2 className="text-sm font-semibold text-white">Account details</h2>
              <dl className="mt-3 grid gap-2 text-sm text-white/70 sm:grid-cols-2">
                 {Object.entries(data.corporate_account).map(([key, value]) => (
                   <div key={key} className="min-w-0">
                    <dt className="text-[0.7rem] font-bold uppercase tracking-wide text-white/65">
                      {key.replace(/_/g, " ")}
                    </dt>
                     <dd className="break-words">{value === null || value === "" ? "Not recorded" : String(value)}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          ) : null}
          {data ? <PortalSummary data={data} currency={currency} onSection={setSection} /> : null}
        </>
      ) : null}

      {data && section === "orders" ? (
        <>
          <PartnerRecordsList
            key={active}
            kind="orders"
            rows={data.purchase_orders ?? []}
            currency={currency}
            onAsk={askAbout}
            onDownload={(number) => void downloadOrder(number)}
            downloading={downloadingOrder}
          />

          {active && branchId &&
            relationships.find((rel) =>
              rel.id === active
            )?.supplier_id && (
              <SupplierLpoResponses
                key={`${user?.id}:${branchId}:${active}`}
                branchId={branchId}
                relationshipId={active}
                orders={data.purchase_orders ?? []}
              />
            )}
        </>
      ) : null}
      {section === "requests" && active && branchId && relationships.find((rel) => rel.id === active)?.supplier_id ? (
        <SupplierRfqs branchId={branchId} relationshipId={active} />
      ) : null}
      {data && section === "deliveries" ? (
        <PartnerRecordsList key={active} kind="deliveries" rows={data.deliveries ?? []} currency={currency} onAsk={askAbout} />
      ) : null}
      {data && section === "invoices" ? (
        <>
          <PartnerRecordsList key={active} kind="invoices" rows={data.invoices ?? []} currency={currency} onAsk={askAbout} />

          {active && branchId &&
            relationships.find((rel) =>
              rel.id === active
            )?.supplier_id && (
              <SupplierInvoiceSubmissions
                key={`${user?.id}:${branchId}:${active}`}
                branchId={branchId}
                relationshipId={active}
                orders={data.purchase_orders ?? []}
              />
            )}
          <CreditInvoices key={active} branchId={branchId} relationshipId={active} onAsk={askAbout} />
        </>
      ) : null}
      {data && section === "messages" ? (
        <PartnerMessages key={`${active}:${messageSubject}`} account={data?.corporate_account ?? null}
          relationshipId={active} initialSubject={messageSubject} />
      ) : null}
    </Shell>
  );
}

/**
 * The partner's own dashboard line: what is still open with this hotel.
 * It counts only the records the hotel has already shared with this partner —
 * nothing is estimated, and an empty portal says so plainly.
 */
function PortalSummary({ data, currency, onSection }: {
  data: PartnerRecords;
  currency: string | null | undefined;
  onSection: (section: PartnerSection) => void;
}) {
  const pendingOrders = (data.purchase_orders ?? []).filter((row) =>
    !["received", "closed", "cancelled", "completed"].includes(String(row["status"])));
  const unpaidInvoices = (data.invoices ?? []).filter((row) =>
    !["paid", "settled", "cancelled", "void", "voided"].includes(String(row["status"]))
      && Number(row["amount"]) > Number(row["paid_amount"] ?? 0));
  const outstanding = unpaidInvoices.reduce((sum, row) => sum + Number(row["amount"]) - Number(row["paid_amount"] ?? 0), 0);
  const tiles: { section: PartnerSection; label: string; value: string; icon: typeof ShoppingBag }[] = [
    { section: "orders", label: "Pending orders", value: String(pendingOrders.length), icon: ShoppingBag },
    { section: "deliveries", label: "Deliveries recorded", value: String(data.deliveries?.length ?? 0), icon: PackageCheck },
    { section: "invoices", label: "Outstanding supplier invoices", value: formatPartnerAmount(outstanding, currency), icon: FileText },
    { section: "messages", label: "Hotel messages", value: "Open inbox", icon: MessageSquareText },
  ];

  return (
    <Panel>
      <h2 className="text-sm font-semibold text-white">Your account with this hotel</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => { const Icon=t.icon; return (
          <button key={t.label} type="button" onClick={() => onSection(t.section)}
            className="min-w-0 rounded-2xl border border-white/10 bg-white/[.07] p-4 text-left hover:bg-white/15">
            <div className="flex items-center justify-between gap-2"><p className="text-[0.7rem] font-bold uppercase tracking-[.12em] text-white/65">{t.label}</p><Icon className="size-4 text-white/60" /></div>
            <p className="mt-3 break-words text-xl font-bold text-white">{t.value}</p>
          </button>
        )})}
      </div>
    </Panel>
  );
}

function formatPartnerAmount(value: unknown, currency: string | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const code = currency?.toUpperCase();
  return `${code && /^[A-Z]{3}$/.test(code) ? code + " " : ""}${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const recordFields = {
  orders: { title: "Purchase orders", reference: "order_number", amount: "total_amount", dates: [["Expected delivery", "expected_date"], ["Created", "created_at"]] },
  deliveries: { title: "Deliveries received", reference: "grn_number", amount: "total_value", dates: [["Received", "received_at"]] },
  invoices: { title: "Invoices and payment status", reference: "invoice_number", amount: "amount", dates: [["Due", "due_date"], ["Issued", "invoice_date"]] },
  credit: { title: "Credit invoices from this hotel", reference: "invoice_number", amount: "total", dates: [["Due", "due_date"], ["Issued", "issue_date"]] },
} as const;

const partnerDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });

function formatPartnerDate(value: unknown) {
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? partnerDate.format(date) : "—";
}

function PartnerRecordsList({ kind, rows, currency, onAsk, onDownload, downloading }: {
  kind: keyof typeof recordFields;
  rows: Record<string, unknown>[];
  currency?: string | null | undefined;
  onAsk: (subject: string) => void;
  onDownload?: (number: string) => void;
  downloading?: string | null;
}) {
  const fields = recordFields[kind];
  const [query, setQuery] = useState("");
  const search = query.trim().toLowerCase();
  const visible = rows.filter((row) => !search || [row[fields.reference], row["status"]].some(
    (value) => String(value ?? "").replace(/[_-]/g, " ").toLowerCase().includes(search.replace(/[_-]/g, " ")),
  ));
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-white">{fields.title}</h2>
        {rows.length ? <span className="text-xs tabular-nums text-white/75" role="status">{visible.length} of {rows.length}</span> : null}
      </div>
      {rows.length ? (
        <label className="mt-3 flex min-h-11 items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-3 text-white">
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="sr-only">Search {fields.title.toLowerCase()}</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by reference or status" className="min-w-0 flex-1 bg-transparent py-2 text-sm placeholder:text-white/65" />
        </label>
      ) : null}
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-white/60">Nothing recorded for your business yet.</p>
      ) : visible.length === 0 ? (
        <p className="mt-3 text-sm text-white/75">No matching records. <button type="button" className="min-h-11 underline" onClick={() => setQuery("")}>Clear search</button></p>
      ) : (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {visible.map((row, index) => {
            const reference = String(row[fields.reference] ?? "");
            const rowCurrency = typeof row["currency"] === "string" ? row["currency"] : currency;
            const paidAmount = row["paid_amount"] ?? row["amount_paid"];
            return (
              <li key={`${reference}:${index}`} className="min-w-0 rounded-2xl border border-white/10 bg-white/[.07] p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="break-words font-semibold text-white">{reference || "Reference pending"}</h3>
                  <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs capitalize text-white/85">{String(row["status"] ?? "Status pending").replace(/[_-]/g, " ")}</span>
                </div>
                <dl className="mt-3 space-y-1 text-sm text-white/75">
                  <div className="flex justify-between gap-2"><dt>Total</dt><dd className="font-medium text-white">{formatPartnerAmount(row[fields.amount], rowCurrency)}</dd></div>
                  {fields.dates.map(([label, field]) => row[field] ? (
                    <div key={field} className="flex justify-between gap-2"><dt>{label}</dt><dd>{formatPartnerDate(row[field])}</dd></div>
                  ) : null)}
                  {paidAmount != null ? <div className="flex justify-between gap-2"><dt>Paid</dt><dd>{formatPartnerAmount(paidAmount, rowCurrency)}</dd></div> : null}
                  {kind === "credit" && row["balance"] != null ? <div className="flex justify-between gap-2"><dt>Balance</dt><dd>{formatPartnerAmount(row["balance"], rowCurrency)}</dd></div> : null}
                  {row["invoiced_amount"] != null ? <div className="flex justify-between gap-2"><dt>Invoiced</dt><dd>{formatPartnerAmount(row["invoiced_amount"], rowCurrency)}</dd></div> : null}
                  {row["is_partial"] === true ? <div><dt>Partial delivery</dt></div> : null}
                  {row["match_status"] ? <div className="flex justify-between gap-2"><dt>Matching</dt><dd className="capitalize">{String(row["match_status"]).replace(/[_-]/g, " ")}</dd></div> : null}
                </dl>
                {reference ? <button type="button" onClick={() => onAsk(reference)} className="mt-3 min-h-11 text-sm font-medium text-white underline underline-offset-4">Ask the hotel about {reference}</button> : null}
                {reference && onDownload &&
                  ["approved","sent","partially-received","received","completed","closed"].includes(String(row["status"])) ? (
                    <button type="button" className="neo-commerce-primary ml-2" disabled={Boolean(downloading)}
                      onClick={() => onDownload(reference)}>
                      {downloading === reference ? "Preparing PDF…" : "Download LPO"}
                    </button>
                  ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <section data-public-panel className="neo-pub-card mt-4 min-w-0 p-5 sm:p-6">{children}</section>;
}

/**
 * Messages between a partner and the hotel. Threads are held against the
 * partner's own relationship with this hotel, so both sides read and write the
 * same conversation.
 */
function PartnerMessages({
  account,
  relationshipId,
  initialSubject,
}: {
  account: Record<string, unknown> | null;
  relationshipId: string | null;
  initialSubject: string;
}) {
  const email = account?.["email"] ? String(account["email"]) : "";
  const phone = account?.["phone"] ? String(account["phone"]) : "";
  const threads = usePartnerThreads(relationshipId);
  const send = useSendPartnerMessage(relationshipId);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState(initialSubject);

  const list: PartnerThread[] = threads.data ?? [];
  const active = list.find((t) => t.id === openThread) ?? null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!body.trim() || send.isPending) return;
    send.mutate(
      { body, threadId: active?.id ?? null, subject: active ? undefined : subject },
      {
        onSuccess: (result: { thread_id?: string }) => {
          setBody("");
          setSubject("");
          const id = result.thread_id ?? null;
          if (id) setOpenThread(id);
        },
      },
    );
  };

  return (
    <Panel>
      <h2 className="text-sm font-semibold text-white">Messages</h2>

      {threads.isLoading ? (
        <p className="mt-2 text-sm text-white/60">Loading your conversations…</p>
      ) : threads.isError ? (
        <button type="button" onClick={() => void threads.refetch()} className="mt-2 text-sm text-white underline">Messages could not load. Try again</button>
      ) : list.length === 0 ? (
        <p className="mt-2 text-sm text-white/65">
          You have no messages with this hotel yet. Start one below.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {list.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => setOpenThread(thread.id === openThread ? null : thread.id)}
                className={`max-w-full truncate rounded-full px-4 py-2 text-xs font-semibold sm:max-w-xs ${
                thread.id === openThread
                  ? "bg-white text-[#020A1C]"
                  : "bg-white/10 text-white hover:bg-white/20"
              }`}
            >
              {thread.subject}
            </button>
          ))}
        </div>
      )}

      {active ? (
        <div className="mt-4 space-y-3">
          {active.messages.map((message) => (
            <div
              key={message.id}
               className={`min-w-0 max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                message.side === "partner"
                  ? "ml-auto bg-white text-[#020A1C]"
                  : "bg-white/10 text-white"
              }`}
            >
               <p className="whitespace-pre-wrap break-words">{message.body}</p>
              <p
                className={`mt-1 text-[11px] ${
                  message.side === "partner" ? "text-[#020A1C]/60" : "text-white/70"
                }`}
              >
                {message.sender_name ?? (message.side === "partner" ? "You" : "Hotel")} ·{" "}
                {new Date(message.at).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <form onSubmit={submit} className="mt-4 space-y-2">
        {!active ? (
          <input
            value={subject}
            aria-label="Message subject"
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What is this about?"
            className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm text-white placeholder:text-white/60"
          />
        ) : null}
        <textarea
          value={body}
          aria-label="Message"
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          placeholder={active ? `Reply in ${active.subject}` : "Write your message"}
          className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm text-white placeholder:text-white/60"
        />
        <button
          type="submit"
          disabled={send.isPending || !body.trim() || !relationshipId}
          className="rounded-full bg-white px-5 py-2 text-xs font-semibold text-[#020A1C] disabled:opacity-50"
        >
          {send.isPending ? "Sending…" : active ? "Send reply" : "Start conversation"}
        </button>
      </form>

      {email || phone ? (
        <p className="mt-4 text-xs text-white/70">
          The hotel can also reach you on {[email, phone].filter(Boolean).join(" · ")}.
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * Partner header identity actions. A partner contact is one identity that may
 * also be a guest or a worker, so context switching must never require a
 * second login, and signing out must use the canonical teardown.
 */
function PartnerIdentityMenu() {
  const signOut = useNeoSignOut();
  const switchAccount = useNeoSwitchAccount();
  const { user } = useAuth();
  if (!user) {
    return <span className="neo-pub-eyebrow">Partner portal</span>;
  }
  return (
    <div className="flex items-center gap-2">
      <a
        href="/continue?choose=1"
        className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/80 transition-colors hover:bg-white/20"
      >
        Switch context
      </a>
      <button
        type="button"
        onClick={() => void switchAccount()}
        className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/80 transition-colors hover:bg-white/20"
      >
        Switch account
      </button>
      <button
        type="button"
        onClick={() => void signOut()}
        className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-[#020A1C]"
      >
        Sign out
      </button>
    </div>
  );
}

function Shell({
  title,
  children,
  property,
  section,
  onSection,
  isSupplier,
}: {
  title: string;
  children: React.ReactNode;
  property?: PublicProperty | null | undefined;
  section?: PartnerSection;
  onSection?: (next: PartnerSection) => void;
  isSupplier?: boolean;
}) {
  const primary = normalizedHex(property?.brand?.primary || brandFallback.primary);
  const secondary = normalizedHex(property?.brand?.accent || brandFallback.secondary, brandFallback.secondary);
  const background = normalizedHex(property?.brand?.surface || brandFallback.background, brandFallback.background);
  return (
    <PublicSurface className="neo-branded-app" style={{
      ...(property?.brand ? brandStyle(property.brand) : {}),
      "--pa-primary": primary, "--pa-on-primary": primaryInk(primary), "--pa-secondary": secondary, "--pa-background": background,
    } as React.CSSProperties}>
      <PublicTopBar
        homeTo="/"
        width="max-w-4xl"
        right={<PartnerIdentityMenu />}
      />
      <PullToRefresh>
       <main className="mx-auto w-full max-w-4xl min-w-0 px-5 pb-20 pt-8">
         <div className="flex min-w-0 items-center gap-4">
           {property ? <BrandMark workspace={{ hotel_name: title, app_name: "Partner portal",
             logo_url: property.media?.logo_url || property.logo_url, primary_color: primary, button_style: "rounded" }} /> : null}
           <Display className="min-w-0 break-words text-3xl sm:text-5xl">{title}</Display>
         </div>
        {section && onSection ? (
          <nav
            aria-label="Partner sections"
            className="neo-partner-tabs mt-6 grid grid-cols-5 gap-1"
          >
            {SECTIONS.filter((s) => s.key !== "requests" || isSupplier).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => onSection(key)}
                aria-current={key === section ? "page" : undefined}
                className={`flex min-h-11 min-w-0 flex-col items-center justify-center gap-1 rounded-2xl px-0.5 py-2 text-[.625rem] font-semibold transition-colors sm:flex-row sm:gap-2 sm:text-xs ${
                  key === section ? "bg-[var(--pa-primary)] text-[var(--pa-on-primary)] shadow-sm" : "text-white/85 hover:bg-white/15"
                }`}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {label}
              </button>
            ))}
          </nav>
        ) : null}
        {children}
        <div className="mt-12 flex justify-center">
          <PoweredByNeo tone="light" />
        </div>
      </main>
      </PullToRefresh>
    </PublicSurface>
  );
}

/**
 * Credit invoices the hotel has raised against this partner's own account.
 * These are real receivables in the hotel's ledger; the partner sees only the
 * invoices billed to the account their relationship is attached to.
 */
function CreditInvoices({
  branchId,
  relationshipId,
  onAsk,
}: {
  branchId: string | null;
  relationshipId: string | null;
  onAsk: (subject: string) => void;
}) {
  const invoices = usePartnerCreditInvoices(branchId, relationshipId);
  if (invoices.isError) return <Panel><button type="button" className="text-white underline" onClick={() => void invoices.refetch()}>Credit invoices could not load. Try again</button></Panel>;
  if (invoices.isLoading) return null;
  const rows = invoices.data ?? [];
  if (rows.length === 0) return null;
  return <PartnerRecordsList kind="credit" rows={rows} onAsk={onAsk} />;
}
