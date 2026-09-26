import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { FileText, Handshake, Loader2, MessageSquareText, PackageCheck, ShoppingBag } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { usePartnerCreditInvoices } from "@/lib/partner-billing";
import {
  usePartnerThreads,
  useSendPartnerMessage,
  type PartnerThread,
} from "@/lib/partner-messaging";
import { fetchPropertyForVisitor } from "@/lib/front-door";
import { PoweredByNeo } from "@/components/public/PublicAppShell";
import { PullToRefresh } from "@/components/common/PullToRefresh";
import { useNeoSignOut, useNeoSwitchAccount } from "@/lib/session-exit";
import { useAuth } from "@/lib/auth";
import { Display, PublicSurface, PublicTopBar } from "@/components/public/NeoPublic";
import { useTrackEntry } from "@/lib/traffic";

export const Route = createFileRoute("/partner/$propertySlug")({
  ssr: false,
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
  relationship_type?: string;
  purchase_orders?: Record<string, unknown>[];
  deliveries?: Record<string, unknown>[];
  invoices?: Record<string, unknown>[];
  corporate_account?: Record<string, unknown> | null;
};

type PartnerSection = "overview" | "orders" | "deliveries" | "invoices" | "messages";

const SECTIONS: { key: PartnerSection; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "orders", label: "Orders" },
  { key: "deliveries", label: "Deliveries" },
  { key: "invoices", label: "Invoices" },
  { key: "messages", label: "Messages" },
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
  const [selected, setSelected] = useState<string | null>(null);
  const [section, setSection] = useState<PartnerSection>("overview");
  // A visitor with no session should be offered sign-in, not told they lack a
  // relationship — the hotel may well have granted them one.
  const session = useQuery({
    queryKey: ["neo-partner-session"],
    queryFn: async () => Boolean((await supabase.auth.getUser()).data.user),
    staleTime: 30_000,
  });


  const property = useQuery({
    queryKey: ["neo-visitor-property", propertySlug],
    queryFn: () => fetchPropertyForVisitor(propertySlug),
    staleTime: 60_000,
  });

  const branchId = property.data?.branch_id ?? null;

  const context = useQuery({
    queryKey: ["neo-partner-context", branchId],
    enabled: Boolean(branchId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_partner_context", {
        _branch: branchId,
      });
      if (error) throw new Error(error.message);
      return data as unknown as PartnerContext;
    },
  });

  const relationships = context.data?.allowed ? context.data.relationships : [];
  const active = selected ?? relationships[0]?.id ?? null;

  const records = useQuery({
    queryKey: ["neo-partner-records", branchId, active],
    enabled: Boolean(branchId && active),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_partner_records", {
        _branch: branchId,
        _relationship: active,
      });
      if (error) throw new Error(error.message);
      return data as unknown as PartnerRecords;
    },
  });

  if (property.isLoading || context.isLoading) {
    return (
      <Shell title="Partner portal">
        <div className="flex items-center gap-2 text-sm text-white/70">
          <Loader2 className="size-4 animate-spin" /> Checking your access…
        </div>
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
      session.data === false
        ? "not_signed_in"
        : context.data && !context.data.allowed
          ? context.data.reason
          : "no_relationship";
    return (
      <Shell title={property.data.property_name}>
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

  const data = records.data;

  return (
    <Shell title={property.data.property_name} section={section} onSection={setSection}>
      <section className="neo-partner-hero">
        <span className="grid size-12 place-items-center rounded-2xl bg-white/12 text-white"><Handshake className="size-5" /></span>
        <div className="min-w-0"><p className="neo-commerce-eyebrow">Private relationship</p><h1 className="mt-1 text-2xl font-bold text-white">Partner workspace</h1><p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/75">Purchase orders, deliveries, invoices and hotel messages for this relationship only.</p></div>
      </section>

      {relationships.length > 1 ? (
        <div className="mb-5 flex flex-wrap gap-2">
          {relationships.map((rel) => (
            <button
              key={rel.id}
              type="button"
              onClick={() => setSelected(rel.id)}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
                rel.id === active ? "bg-white text-[#020A1C]" : "bg-white/10 text-white/70"
              }`}
            >
              {rel.display_name ?? rel.relationship_type}
            </button>
          ))}
        </div>
      ) : (
        <p className="mb-5 text-sm text-white/60">
          {relationships[0]?.display_name ?? "Your business"} ·{" "}
          {relationships[0]?.relationship_type.replace(/_/g, " ")}
        </p>
      )}

      {records.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-white/70">
          <Loader2 className="size-4 animate-spin" /> Loading your records…
        </div>
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
          {data ? <PortalSummary data={data} /> : null}
        </>
      ) : null}

      {section === "orders" ? (
        <RecordTable title="Purchase orders" rows={data?.purchase_orders} />
      ) : null}
      {section === "deliveries" ? (
        <RecordTable title="Deliveries received" rows={data?.deliveries} />
      ) : null}
      {section === "invoices" ? (
        <>
          <RecordTable title="Invoices and payment status" rows={data?.invoices} />
          <CreditInvoices branchId={branchId} relationshipId={active} />
        </>
      ) : null}
      {section === "messages" ? (
        <PartnerMessages account={data?.corporate_account ?? null} relationshipId={active} />
      ) : null}
    </Shell>
  );
}

/**
 * The partner's own dashboard line: what is still open with this hotel.
 * It counts only the records the hotel has already shared with this partner —
 * nothing is estimated, and an empty portal says so plainly.
 */
function PortalSummary({ data }: { data: PartnerRecords }) {
  const open = (rows: Record<string, unknown>[] | undefined, closed: string[]) =>
    (rows ?? []).filter((r) => {
      const status = String(r["status"] ?? r["payment_status"] ?? "").toLowerCase();
      return status ? !closed.includes(status) : true;
    });

  const pendingOrders = open(data.purchase_orders, ["received", "closed", "cancelled", "completed"]);
  const unpaidInvoices = open(data.invoices, ["paid", "settled", "cancelled", "void"]);
  const outstanding = unpaidInvoices.reduce((sum, r) => {
    const explicit = r["balance_due"] ?? r["outstanding"];
    const gross = Number(r["amount"] ?? r["total_amount"] ?? 0);
    const paid = Number(r["paid_amount"] ?? 0);
    const value =
      explicit != null
        ? Number(explicit)
        : (Number.isFinite(gross) ? gross : 0) - (Number.isFinite(paid) ? paid : 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);


  const tiles = [
    { label: "Pending orders", value: String(pendingOrders.length), icon: ShoppingBag },
    { label: "Deliveries recorded", value: String((data.deliveries ?? []).length), icon: PackageCheck },
    { label: "Unpaid invoices", value: String(unpaidInvoices.length), icon: FileText },
    { label: "Outstanding amount", value: outstanding > 0 ? outstanding.toLocaleString() : "Clear", icon: MessageSquareText },
  ];

  return (
    <Panel>
      <h2 className="text-sm font-semibold text-white">Your account with this hotel</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => { const Icon=t.icon; return (
          <div key={t.label} className="rounded-2xl border border-white/10 bg-white/[.07] p-4">
            <div className="flex items-center justify-between gap-2"><p className="text-[0.7rem] font-bold uppercase tracking-[.12em] text-white/65">{t.label}</p><Icon className="size-4 text-white/60" /></div>
            <p className="mt-3 truncate text-xl font-bold text-white">{t.value}</p>
          </div>
        )})}
      </div>
    </Panel>
  );
}

function RecordTable({
  title,
  rows,
}: {
  title: string;
  rows: Record<string, unknown>[] | undefined;
}) {
  if (!rows) return null;
  return (
    <Panel>
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-white/60">Nothing recorded for your business yet.</p>
      ) : (
        <div className="neo-table-scroll mt-3">
          <table className="w-full min-w-[36rem] table-fixed text-left text-xs text-white/70">
            <thead>
              <tr>
                {Object.keys(rows[0]!).map((key) => (
                  <th key={key} className="truncate pb-2 pr-4 font-semibold text-white/65" title={key.replace(/_/g, " ")}>
                    {key.replace(/_/g, " ")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index} className="border-t border-white/5">
                  {Object.values(row).map((value, i) => (
                    <td key={i} className="truncate py-2 pr-4" title={value === null || value === "" ? "—" : String(value)}>
                      {value === null || value === "" ? "—" : String(value)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
}: {
  account: Record<string, unknown> | null;
  relationshipId: string | null;
}) {
  const email = account?.["email"] ? String(account["email"]) : "";
  const phone = account?.["phone"] ? String(account["phone"]) : "";
  const threads = usePartnerThreads(relationshipId);
  const send = useSendPartnerMessage(relationshipId);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");

  const list: PartnerThread[] = threads.data ?? [];
  const active = list.find((t) => t.id === openThread) ?? null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
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
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What is this about?"
            className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm text-white placeholder:text-white/60"
          />
        ) : null}
        <textarea
          value={body}
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
  section,
  onSection,
}: {
  title: string;
  children: React.ReactNode;
  section?: PartnerSection;
  onSection?: (next: PartnerSection) => void;
}) {
  return (
    <PublicSurface>
      <PublicTopBar
        homeTo="/"
        width="max-w-4xl"
        right={<PartnerIdentityMenu />}
      />
      <PullToRefresh>
       <main className="mx-auto w-full max-w-4xl min-w-0 px-5 pb-20 pt-8">
         <Display className="break-words text-3xl sm:text-5xl">{title}</Display>
        {section && onSection ? (
          <nav
            aria-label="Partner sections"
            className="neo-partner-tabs mt-6 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]"
          >
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => onSection(s.key)}
                aria-current={s.key === section ? "page" : undefined}
                className={`shrink-0 rounded-full px-4 py-2 text-xs font-semibold transition-colors ${
                  s.key === section ? "bg-white text-[#020A1C] shadow-sm" : "bg-white/10 text-white/80 hover:bg-white/15"
                }`}
              >
                {s.label}
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
}: {
  branchId: string | null;
  relationshipId: string | null;
}) {
  const invoices = usePartnerCreditInvoices(branchId, relationshipId);
  if (invoices.isLoading) return null;
  const rows = invoices.data ?? [];
  if (rows.length === 0) return null;
  return <RecordTable title="Credit invoices from this hotel" rows={rows} />;
}
