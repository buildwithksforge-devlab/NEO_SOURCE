import { LoadingState } from "@/components/common/StateSystem";
import { createFileRoute } from "@tanstack/react-router";
import { Heart } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { EmptyState, MetricTile } from "@/components/marketing/MarketingShared";
import { useMyCustomerRecord, useMyEngagement, useSetConsent } from "@/lib/marketing-data";
import {
  CONSENT_CHANNELS,
  consentStatusLabels,
  consentTone,
  formatDate,
  titleCase,
} from "@/lib/marketing";

export const Route = createFileRoute("/_shell/my-engagement")({
  head: () => ({
    meta: [
      { title: "My Engagement — Guest Portal" },
      {
        name: "description",
        content: "Manage your marketing preferences, rewards, vouchers and referrals in one place.",
      },
      { property: "og:title", content: "My Engagement — Guest Portal" },
      {
        property: "og:description",
        content: "Your communication preferences, rewards and referrals.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

type Row = Record<string, any>;

function Page() {
  const { data: me, isLoading } = useMyCustomerRecord();
  const { data: engagement } = useMyEngagement(me ? String(me["id"]) : undefined);
  const setConsent = useSetConsent();

  if (isLoading) {
    return <LoadingState variant="cards" rows={3} />;
  }

  if (!me) {
    return (
      <SectionCard title="Guest portal" description="This area shows your own engagement record.">
        <EmptyState
          icon={Heart}
          title="No customer profile linked to this account"
          description="Staff accounts do not have a guest engagement record. Sign in with the guest account used for bookings to see your preferences, rewards and referrals."
        />
      </SectionCard>
    );
  }

  const loyalty = engagement?.loyalty ?? null;
  const consents = (engagement?.consents ?? []) as Row[];
  const vouchers = (engagement?.vouchers ?? []) as Row[];
  const referrals = (engagement?.referrals ?? []) as Row[];
  const reviews = (engagement?.reviews ?? []) as Row[];

  return (
    <div>
      <PageHeader
        eyebrow="Guest Portal"
        title="My Engagement"
        description="Everything we hold about how we contact and reward you. You can withdraw marketing consent at any time — important booking and payment messages will still reach you."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricTile
          label="Loyalty tier"
          value={String((loyalty?.["loyalty_tiers"] as Row | null)?.["name"] ?? "Not enrolled")}
        />
        <MetricTile
          label="Points balance"
          value={Number(loyalty?.["points_balance"] ?? 0).toLocaleString()}
        />
        <MetricTile
          label="Active vouchers"
          value={String(vouchers.filter((v) => String(v["status"]) === "active").length)}
        />
      </div>

      <SectionCard
        className="mt-6"
        title="Communication preferences"
        description="Choose how we may send you offers and news."
      >
        <ul className="space-y-2">
          {CONSENT_CHANNELS.map((channel) => {
            const record = consents.find(
              (c) =>
                String(c["channel"]) === channel &&
                String(c["purpose"] ?? "marketing") === "marketing",
            );
            const status = String(record?.["status"] ?? "unknown");
            const granted = status === "granted";
            return (
              <li
                key={channel}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">{titleCase(channel)}</p>
                  <StatusPill tone={consentTone(status)}>
                    {consentStatusLabels[status as keyof typeof consentStatusLabels] ??
                      "Not recorded"}
                  </StatusPill>
                </div>
                <Button
                  size="sm"
                  variant={granted ? "outline" : "default"}
                  disabled={setConsent.isPending}
                  onClick={() =>
                    setConsent.mutate({
                      customerId: String(me["id"]),
                      channel,
                      purpose: "marketing",
                      status: granted ? "withdrawn" : "granted",
                      source: "guest_portal",
                    })
                  }
                >
                  {granted ? "Withdraw" : "Opt in"}
                </Button>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          Withdrawing takes effect immediately. Booking confirmations, payment receipts and safety
          notices are not marketing and continue regardless.
        </p>
      </SectionCard>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="My vouchers"
          description="Personal rewards you can redeem on your next visit."
        >
          {!vouchers.length ? (
            <p className="text-sm text-muted-foreground">You have no vouchers at the moment.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {vouchers.map((v) => (
                <li
                  key={String(v["id"])}
                  className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
                >
                  <span className="font-mono text-xs">{String(v["code"])}</span>
                  <span className="text-muted-foreground">
                    {Number(v["value"] ?? 0).toLocaleString()} · {titleCase(String(v["status"]))}
                    {v["expires_at"] ? ` · expires ${formatDate(v["expires_at"])}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="My referrals"
          description="People you have invited and their reward status."
        >
          {!referrals.length ? (
            <p className="text-sm text-muted-foreground">You have not referred anyone yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {referrals.map((r) => (
                <li
                  key={String(r["id"])}
                  className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
                >
                  <span>{formatDate(r["created_at"])}</span>
                  <StatusPill
                    tone={String(r["reward_status"]) === "qualified" ? "success" : "default"}
                  >
                    {titleCase(String(r["reward_status"] ?? "pending"))}
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard
        className="mt-6"
        title="My reviews"
        description="Feedback you have shared with us."
      >
        {!reviews.length ? (
          <p className="text-sm text-muted-foreground">No reviews submitted.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {reviews.map((r) => (
              <li key={String(r["id"])} className="rounded-lg border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  {formatDate(r["review_date"])}
                  {r["rating"] != null ? ` · ${Number(r["rating"])}/5` : ""}
                </p>
                {r["body"] ? <p className="mt-1">{String(r["body"])}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
