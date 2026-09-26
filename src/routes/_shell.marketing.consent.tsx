import { useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConsentNotice, EmptyState } from "@/components/marketing/MarketingShared";
import {
  useConsentNotices,
  useConsents,
  useCreateConsentNotice,
  useCustomersLookup,
  useSetConsent,
} from "@/lib/marketing-data";
import {
  CONSENT_CHANNELS,
  CONSENT_PURPOSES,
  CONSENT_STATUSES,
  consentStatusLabels,
  consentTone,
  formatDateTime,
  titleCase,
} from "@/lib/marketing";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_shell/marketing/consent")({
  head: () => ({
    meta: [
      { title: "Audience Consent — Marketing & CRM" },
      {
        name: "description",
        content:
          "Per-channel, per-purpose marketing consent with recorded source, evidence and notice version.",
      },
      { property: "og:title", content: "Audience Consent — Marketing & CRM" },
      {
        property: "og:description",
        content: "Consent register with evidence and versioned privacy notices.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Row = Record<string, any>;

function Page() {
  const { can } = useAuth();
  const { data: consents } = useConsents();
  const { data: notices } = useConsentNotices();
  const setConsent = useSetConsent();
  const createNotice = useCreateConsentNotice();
  const [search, setSearch] = useState("");
  const { data: customers } = useCustomersLookup(search);

  const [customerId, setCustomerId] = useState("");
  const [channel, setChannel] = useState<string>("email");
  const [purpose, setPurpose] = useState<string>("marketing");
  const [status, setStatus] = useState<string>("granted");
  const [noticeBody, setNoticeBody] = useState("");
  const [noticeVersion, setNoticeVersion] = useState("");

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Audience Consent"
        description="Consent is stored per channel and per purpose with its source and evidence. Transactional messages are never blocked by marketing consent, and marketing messages are never sent without it."
      />

      <ConsentNotice />

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {can("marketing", "edit") ? (
          <SectionCard
            title="Record consent"
            description="Capture an opt-in or a withdrawal on a customer's behalf."
          >
            <div className="space-y-3">
              <div>
                <Label>Customer</Label>
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search customers"
                />
                <div className="mt-2 max-h-36 space-y-1 overflow-y-auto">
                  {((customers ?? []) as Row[]).map((c) => (
                    <button
                      key={String(c["id"])}
                      type="button"
                      onClick={() => setCustomerId(String(c["id"]))}
                      className={`w-full rounded-lg border px-3 py-1.5 text-left text-sm ${
                        customerId === String(c["id"])
                          ? "border-primary bg-primary/5"
                          : "border-border"
                      }`}
                    >
                      {String(c["full_name"])}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Label>Channel</Label>
                <Select value={channel} onValueChange={setChannel}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONSENT_CHANNELS.map((c) => (
                      <SelectItem key={c} value={c}>
                        {titleCase(c)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Purpose</Label>
                <Select value={purpose} onValueChange={setPurpose}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONSENT_PURPOSES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {titleCase(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Status</Label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONSENT_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {consentStatusLabels[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                className="w-full"
                disabled={!customerId || setConsent.isPending}
                onClick={() =>
                  setConsent.mutate({
                    customerId,
                    channel,
                    purpose,
                    status,
                    source: "staff_recorded",
                  })
                }
              >
                Record consent
              </Button>
              <p className="text-xs text-muted-foreground">
                Withdrawals take effect immediately and add a suppression entry on that channel.
              </p>
            </div>
          </SectionCard>
        ) : null}

        <SectionCard
          title="Consent register"
          description="Most recent records first."
          className="lg:col-span-2"
        >
          {!consents?.length ? (
            <EmptyState
              icon={ShieldCheck}
              title="No consent recorded"
              description="Consent captured at booking, on the guest portal or by staff appears here with its evidence."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Recorded</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(consents as Row[]).map((c) => (
                    <TableRow key={String(c["id"])}>
                      <TableCell>
                        {c["customers"]?.full_name ?? String(c["customer_id"]).slice(0, 8)}
                      </TableCell>
                      <TableCell>{titleCase(String(c["channel"]))}</TableCell>
                      <TableCell>{titleCase(String(c["purpose"] ?? "marketing"))}</TableCell>
                      <TableCell>
                        <StatusPill tone={consentTone(String(c["status"]))}>
                          {consentStatusLabels[
                            String(c["status"]) as keyof typeof consentStatusLabels
                          ] ?? titleCase(String(c["status"]))}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {titleCase(String(c["consent_source"] ?? "unknown"))}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDateTime(c["effective_at"] ?? c["created_at"])}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard
        className="mt-6"
        title="Privacy notice versions"
        description="Every consent record references the notice text that was shown at the time."
      >
        <ul className="space-y-2 text-sm">
          {((notices ?? []) as Row[]).map((n) => (
            <li key={String(n["id"])} className="rounded-lg border border-border p-3">
              <p className="font-medium text-foreground">Version {String(n["version"])}</p>
              <p className="text-xs text-muted-foreground">
                Effective {formatDateTime(n["effective_from"])}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                {String(n["body"] ?? "")}
              </p>
            </li>
          ))}
          {!notices?.length ? (
            <p className="text-muted-foreground">No notice versions published.</p>
          ) : null}
        </ul>

        {can("marketing", "create") ? (
          <div className="mt-4 space-y-2 rounded-lg border border-dashed border-border p-3">
            <Label>Publish a new notice version</Label>
            <Input
              placeholder="Version label, e.g. 2026-01"
              value={noticeVersion}
              onChange={(e) => setNoticeVersion(e.target.value)}
            />
            <Textarea
              rows={3}
              placeholder="Notice text shown to customers"
              value={noticeBody}
              onChange={(e) => setNoticeBody(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!noticeVersion || !noticeBody || createNotice.isPending}
              onClick={() =>
                createNotice.mutate(
                  {
                    version: noticeVersion,
                    title: `Marketing privacy notice ${noticeVersion}`,
                    body: noticeBody,
                  },
                  {
                    onSuccess: () => {
                      setNoticeVersion("");
                      setNoticeBody("");
                    },
                  },
                )
              }
            >
              Publish version
            </Button>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/marketing/consent">
      <Page />
    </OpsGuard>
  );
}
