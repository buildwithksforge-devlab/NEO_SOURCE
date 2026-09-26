import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { NeoDateRangePicker } from "@/components/common/DatePicker";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, QueryState } from "@/components/pms/PmsShared";
import { OpsGuard } from "@/components/operations/OpsShared";
import { formatDate, money, titleCase } from "@/lib/pms";
import {
  useAccountAging,
  useCorporateAccounts,
  useCreditCheck,
  useSaveCreditSettings,
} from "@/lib/frontdesk-ops";

export const Route = createFileRoute("/_shell/credit-accounts")({
  head: () => ({
    meta: [
      { title: "Credit & Corporate Accounts — NEØ" },
      {
        name: "description",
        content:
          "Corporate credit terms, approval status, authorised charging, ageing balances and hard limit checks.",
      },
      { property: "og:title", content: "Credit & Corporate Accounts — NEØ" },
      {
        property: "og:description",
        content:
          "Corporate credit terms, approval status, authorised charging, ageing balances and hard limit checks.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard path="/credit-accounts">
      <CreditAccountsPage />
    </OpsGuard>
  ),
});

type Account = Record<string, any>;

const CREDIT_STATUSES = ["pending", "approved", "suspended", "expired", "closed"] as const;
const BILLING_CYCLES = ["on-departure", "weekly", "fortnightly", "monthly"] as const;

function statusTone(status: string) {
  if (status === "approved") return "success" as const;
  if (status === "pending") return "warning" as const;
  if (status === "suspended" || status === "expired" || status === "closed")
    return "destructive" as const;
  return "default" as const;
}

function CreditAccountsPage() {
  const [search, setSearch] = useState("");
  const accounts = useCorporateAccounts(search);
  const rows = (accounts.data ?? []) as Account[];
  const [selected, setSelected] = useState<Account | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);

  return (
    <div>
      <PageHeader
        eyebrow="Commercial"
        title="Credit & Corporate Accounts"
        description="Negotiated terms, credit approval, authorised charging and ageing. Expired, suspended and over-limit accounts are refused by the backend before any charge is accepted."
        actions={
          <Input
            className="w-64"
            placeholder="Search company"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search corporate accounts"
          />
        }
      />

      <SectionCard
        title={`${rows.length} corporate account(s)`}
        description="Select an account to inspect its credit position."
      >
        <QueryState
          isLoading={accounts.isLoading}
          error={accounts.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={CreditCard}
              title="No corporate accounts"
              description="Corporate accounts are created from the CRM once a company agreement is signed. Credit terms are then applied here."
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Credit status</TableHead>
                  <TableHead>Terms</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead className="text-right">Credit limit</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => {
                  const s = (a["corporate_credit_settings"] ?? [])[0] as Account | undefined;
                  const status = String(s?.["credit_status"] ?? "not-configured");
                  return (
                    <TableRow key={String(a["id"])}>
                      <TableCell className="font-medium">{String(a["legal_name"])}</TableCell>
                      <TableCell>
                        <StatusPill tone={statusTone(status)}>{titleCase(status)}</StatusPill>
                      </TableCell>
                      <TableCell>
                        {s
                          ? `${s["payment_terms_days"] ?? 0} days · ${titleCase(String(s["billing_cycle"] ?? ""))}`
                          : "Not configured"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {s?.["effective_from"]
                          ? `${formatDate(s["effective_from"])} → ${s["effective_to"] ? formatDate(s["effective_to"]) : "open"}`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {s ? money(s["credit_limit"]) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setSelected(a)}>
                            Position
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>
                            Credit terms
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </QueryState>
      </SectionCard>

      <PositionDialog account={selected} onClose={() => setSelected(null)} />
      <TermsDialog account={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function PositionDialog({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const [amount, setAmount] = useState("0");
  const id = account ? String(account["id"]) : "";
  const aging = useAccountAging(id);
  const check = useCreditCheck(id, Number(amount) || 0);

  return (
    <Dialog open={Boolean(account)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {account ? String(account["legal_name"]) : "Account"} — credit position
          </DialogTitle>
          <DialogDescription>
            Ageing comes from posted invoices and allocated payments. The authorisation test is the
            same one the backend runs before a charge is accepted.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="aging">
          <TabsList>
            <TabsTrigger value="aging">Ageing</TabsTrigger>
            <TabsTrigger value="authorise">Authorisation test</TabsTrigger>
          </TabsList>

          <TabsContent value="aging" className="mt-4">
            <QueryState
              isLoading={aging.isLoading}
              error={aging.error}
              isEmpty={(aging.data ?? []).length === 0}
              empty={
                <EmptyState
                  icon={CreditCard}
                  title="Nothing outstanding"
                  description="No invoiced balance is currently carried on this account."
                />
              }
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Bucket</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(aging.data ?? []).map((b) => (
                    <TableRow key={b.bucket}>
                      <TableCell>{titleCase(b.bucket)}</TableCell>
                      <TableCell className="text-right font-medium">{money(b.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </QueryState>
          </TabsContent>

          <TabsContent value="authorise" className="mt-4 grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="credit-amount">Proposed charge</Label>
              <Input
                id="credit-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <QueryState
              isLoading={check.isLoading}
              error={check.error}
              isEmpty={!check.data}
              empty={
                <p className="text-sm text-muted-foreground">No credit agreement configured.</p>
              }
            >
              {check.data ? (
                <div className="rounded-lg border border-border p-4">
                  <StatusPill tone={check.data.allowed ? "success" : "destructive"}>
                    {check.data.allowed ? "Charge permitted" : "Charge refused"}
                  </StatusPill>
                  <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-xs text-muted-foreground">Credit limit</dt>
                      <dd className="font-medium">{money(check.data.credit_limit)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Current exposure</dt>
                      <dd className="font-medium">{money(check.data.exposure)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Available</dt>
                      <dd className="font-medium">{money(check.data.available)}</dd>
                    </div>
                  </dl>
                  {(check.data.reasons ?? []).length > 0 ? (
                    <ul className="mt-3 list-disc pl-5 text-sm text-muted-foreground">
                      {check.data.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </QueryState>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function TermsDialog({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const save = useSaveCreditSettings();
  const existing = account
    ? ((account["corporate_credit_settings"] ?? [])[0] as Account | undefined)
    : undefined;
  const [creditStatus, setCreditStatus] = useState(
    String(existing?.["credit_status"] ?? "pending"),
  );
  const [creditLimit, setCreditLimit] = useState(String(existing?.["credit_limit"] ?? "0"));
  const [terms, setTerms] = useState(String(existing?.["payment_terms_days"] ?? "30"));
  const [cycle, setCycle] = useState(String(existing?.["billing_cycle"] ?? "monthly"));
  const [from, setFrom] = useState(String(existing?.["effective_from"] ?? ""));
  const [to, setTo] = useState(String(existing?.["effective_to"] ?? ""));
  const [reason, setReason] = useState(String(existing?.["suspension_reason"] ?? ""));

  const suspended = creditStatus === "suspended";
  const invalid =
    Number.isNaN(Number(creditLimit)) ||
    Number(creditLimit) < 0 ||
    Number.isNaN(Number(terms)) ||
    (suspended && reason.trim().length < 5) ||
    (Boolean(from) && Boolean(to) && from > to);

  return (
    <Dialog open={Boolean(account)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Credit terms — {account ? String(account["legal_name"]) : ""}</DialogTitle>
          <DialogDescription>
            Approval, limit and effective dates are enforced on every corporate charge, not only in
            this screen.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Credit status</Label>
              <Select value={creditStatus} onValueChange={setCreditStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREDIT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {titleCase(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Billing cycle</Label>
              <Select value={cycle} onValueChange={setCycle}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BILLING_CYCLES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {titleCase(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="credit-limit">Credit limit</Label>
              <Input
                id="credit-limit"
                inputMode="decimal"
                value={creditLimit}
                onChange={(e) => setCreditLimit(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="credit-terms">Payment terms (days)</Label>
              <Input
                id="credit-terms"
                inputMode="numeric"
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
              />
            </div>
            <div className="col-span-2 grid gap-1.5">
              <Label>Effective period</Label>
              <NeoDateRangePicker
                from={from}
                to={to}
                onChange={({ from: f, to: t }) => {
                  setFrom(f);
                  setTo(t);
                }}
              />
            </div>
          </div>
          {suspended ? (
            <div className="grid gap-1.5">
              <Label htmlFor="credit-reason">Suspension reason (required)</Label>
              <Textarea
                id="credit-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          ) : null}
          <Button
            disabled={invalid || save.isPending}
            onClick={() =>
              save.mutate(
                {
                  id: existing ? String(existing["id"]) : null,
                  accountId: String(account!["id"]),
                  creditStatus,
                  creditLimit: Number(creditLimit),
                  paymentTermsDays: Number(terms),
                  billingCycle: cycle,
                  effectiveFrom: from || null,
                  effectiveTo: to || null,
                  suspensionReason: reason,
                },
                { onSuccess: onClose },
              )
            }
          >
            {save.isPending ? "Saving…" : "Save credit terms"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
