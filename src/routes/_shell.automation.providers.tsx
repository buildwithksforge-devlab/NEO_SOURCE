import { useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PROVIDERS,
  statusTone,
  titleCase,
  useAutomationRefresh,
  useProviderConnections,
} from "@/lib/automation";
import {
  getProviderCredentialSummary,
  refreshProviderStatus,
  saveProviderCredentials,
  saveProviderSender,
} from "@/lib/automation.functions";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_shell/automation/providers")({
  head: () => ({
    meta: [
      { title: "Provider Connections — Automation Centre" },
      {
        name: "description",
        content: "Truthful connection status for email, WhatsApp, SMS and AI providers.",
      },
      { property: "og:title", content: "Provider Connections — Automation Centre" },
      {
        property: "og:description",
        content: "Provider credentials are stored server-side and never exposed to the browser.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

function ProvidersPage() {
  const { can, isAdmin } = useAuth();
  const connections = useProviderConnections();
  const refresh = useAutomationRefresh();
  const check = useServerFn(refreshProviderStatus);
  const canManage = can("automation-providers", "edit");

  async function runCheck() {
    try {
      await check({});
      refresh();
      toast.success("Provider status refreshed from the backend");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Check failed");
    }
  }

  const byKey = new Map(
    (
      (connections.data ?? []) as unknown as {
        provider: string;
        status: string;
        last_checked_at: string | null;
        last_error: string | null;
        enabled: boolean;
        configuration: Record<string, string> | null;
      }[]
    ).map((c) => [c.provider, c]),
  );

  return (
    <div>
      <PageHeader
        eyebrow="Automation & Communications"
        title="Provider connections"
        description="Sending activates only when real credentials exist in the backend. Nothing here simulates a connection."
        actions={
          canManage ? (
            <Button variant="outline" onClick={runCheck}>
              <RefreshCw className="size-4" /> Check connections
            </Button>
          ) : null
        }
      />

      <SectionCard title="Channels">
        <ul className="grid gap-3 md:grid-cols-2">
          {PROVIDERS.map((p) => {
            const conn = byKey.get(p.key);
            const status = conn?.status ?? "not_configured";
            return (
              <li key={p.key} className="rounded-xl border border-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground">{titleCase(p.channel)} channel</p>
                  </div>
                  <StatusPill tone={statusTone(status)}>{titleCase(status)}</StatusPill>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Required backend secrets: {p.secrets.length ? p.secrets.join(", ") : "none"}
                </p>
                {conn?.last_checked_at ? (
                  <p className="text-xs text-muted-foreground">
                    Last checked {new Date(conn.last_checked_at).toLocaleString()}
                  </p>
                ) : null}
                {conn?.last_error ? (
                  <p className="mt-1 text-xs text-destructive">{conn.last_error}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-xs text-muted-foreground">
          Credentials are added as backend secrets by an administrator and are never stored in
          frontend code or shown in this screen. Until a provider reports “Connected”, workflows
          continue to queue messages without dispatching them.
        </p>
      </SectionCard>

      {canManage || isAdmin ? (
        <>
          <WorkspaceAccountsCard onSaved={refresh} />
          <SenderIdentityCard
            email={byKey.get("resend")?.configuration ?? null}
            sms={byKey.get("africastalking")?.configuration ?? null}
            onSaved={refresh}
          />
          <SectionCard
            title="M-Pesa (Safaricom Daraja)"
            description="Paybill or till collections are set up on their own screen, where the credentials can be tested against Safaricom before any guest is charged."
          >
            <Button asChild variant="outline" size="sm">
              <Link to="/admin/payments-mpesa">Open M-Pesa setup</Link>
            </Button>
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}

/**
 * Each workspace connects its own messaging accounts. The values are written
 * to a store the browser cannot read back: a saved field only ever returns as
 * its last four characters, so a manager can confirm which account is in use
 * without the credential ever being sent to a browser again.
 */
const ACCOUNT_FORMS: {
  provider: string;
  title: string;
  description: string;
  fields: { key: string; label: string; hint?: string }[];
}[] = [
  {
    provider: "africastalking",
    title: "SMS — Africa's Talking",
    description:
      "From your Africa's Talking dashboard: the username of the app and an API key created under Settings → API Key.",
    fields: [
      { key: "username", label: "Username", hint: "Use 'sandbox' only for testing." },
      { key: "api_key", label: "API key" },
    ],
  },
  {
    provider: "whatsapp",
    title: "WhatsApp — Cloud API (Meta)",
    description:
      "From Meta for Developers → WhatsApp → API Setup: a permanent access token and the phone number ID of the sending number.",
    fields: [
      { key: "token", label: "Access token" },
      { key: "phone_id", label: "Phone number ID" },
    ],
  },
  {
    provider: "resend",
    title: "Email — Resend",
    description: "An API key from your Resend account. Leave this blank to keep using the platform's email key.",
    fields: [{ key: "api_key", label: "API key" }],
  },
];

function WorkspaceAccountsCard({ onSaved }: { onSaved: () => void }) {
  const loadSummary = useServerFn(getProviderCredentialSummary);
  const save = useServerFn(saveProviderCredentials);
  const summary = useQuery({
    queryKey: ["provider-credential-summary"],
    queryFn: () => loadSummary({ data: undefined as never }),
  });
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function submit(provider: string, fields: { key: string }[]) {
    setBusy(provider);
    try {
      const payload: Record<string, string> = {};
      for (const field of fields) {
        const value = values[`${provider}.${field.key}`];
        if (value !== undefined) payload[field.key] = value;
      }
      if (!Object.keys(payload).length) {
        toast.info("Nothing to save — enter the account details first.");
        return;
      }
      await save({ data: { provider, values: payload } });
      setValues((prev) => {
        const next = { ...prev };
        for (const field of fields) delete next[`${provider}.${field.key}`];
        return next;
      });
      await summary.refetch();
      onSaved();
      toast.success("Account details saved. Use “Check connections” to confirm the status.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the account details");
    } finally {
      setBusy(null);
    }
  }

  return (
    <SectionCard
      title="Your provider accounts"
      description="Connect the workspace's own messaging accounts. Details are stored server-side and are never shown again in full."
    >
      <div className="grid gap-6 md:grid-cols-3">
        {ACCOUNT_FORMS.map((form) => {
          const saved = (summary.data ?? {})[form.provider] ?? {};
          return (
            <form
              key={form.provider}
              className="space-y-3 rounded-xl border border-border p-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submit(form.provider, form.fields);
              }}
            >
              <div>
                <p className="text-sm font-medium">{form.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{form.description}</p>
              </div>
              {form.fields.map((field) => {
                const id = `${form.provider}-${field.key}`;
                const current = saved[field.key];
                return (
                  <div key={field.key} className="space-y-1">
                    <Label htmlFor={id}>{field.label}</Label>
                    <Input
                      id={id}
                      type="password"
                      autoComplete="off"
                      value={values[`${form.provider}.${field.key}`] ?? ""}
                      onChange={(e) =>
                        setValues((prev) => ({ ...prev, [`${form.provider}.${field.key}`]: e.target.value }))
                      }
                      placeholder={current ? `Saved (${current})` : "Not set"}
                    />
                    {field.hint ? <p className="text-xs text-muted-foreground">{field.hint}</p> : null}
                  </div>
                );
              })}
              <Button type="submit" size="sm" disabled={busy === form.provider}>
                Save account
              </Button>
              <p className="text-xs text-muted-foreground">
                Clearing a field and saving removes the stored value.
              </p>
            </form>
          );
        })}
      </div>
    </SectionCard>
  );
}

type SenderConfig = Record<string, string> | null;

/**
 * The visible sender a guest sees. A message cannot leave until this is set:
 * the provider rejects an unverified sending address, so the queue reports
 * "sender not configured" rather than silently dropping the message.
 */
function SenderIdentityCard({
  email,
  sms,
  onSaved,
}: {
  email: SenderConfig;
  sms: SenderConfig;
  onSaved: () => void;
}) {
  const save = useServerFn(saveProviderSender);
  const [fromEmail, setFromEmail] = useState(email?.["from_email"] ?? "");
  const [fromName, setFromName] = useState(email?.["from_name"] ?? "");
  const [replyTo, setReplyTo] = useState(email?.["reply_to"] ?? "");
  const [senderId, setSenderId] = useState(sms?.["sender_id"] ?? "");
  const [countryCode, setCountryCode] = useState(sms?.["default_country_code"] ?? "");
  const [busy, setBusy] = useState(false);

  async function submit(provider: string, payload: Record<string, string>) {
    setBusy(true);
    try {
      await save({ data: { provider, ...payload } });
      onSaved();
      toast.success("Sender details saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the sender details");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="Sending identity"
      description="The name and address a guest sees when a message arrives. The sending address must be one your email provider has verified."
    >
      <div className="grid gap-6 md:grid-cols-2">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit("resend", { fromEmail, fromName, replyTo });
          }}
        >
          <p className="text-sm font-medium">Email</p>
          <div className="space-y-1">
            <Label htmlFor="from-name">Sender name</Label>
            <Input
              id="from-name"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="Front Office"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="from-email">Sending address</Label>
            <Input
              id="from-email"
              type="email"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              placeholder="reservations@yourdomain.com"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="reply-to">Reply-to address (optional)</Label>
            <Input
              id="reply-to"
              type="email"
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={busy}>
            Save email sender
          </Button>
        </form>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit("africastalking", { senderId, defaultCountryCode: countryCode });
          }}
        >
          <p className="text-sm font-medium">SMS</p>
          <div className="space-y-1">
            <Label htmlFor="sender-id">Sender ID (optional)</Label>
            <Input
              id="sender-id"
              value={senderId}
              onChange={(e) => setSenderId(e.target.value)}
              placeholder="Registered short name"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="country-code">Country dialling code</Label>
            <Input
              id="country-code"
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value)}
              placeholder="254"
            />
            <p className="text-xs text-muted-foreground">
              Used only to complete numbers saved without a country code. Numbers already in
              international format are left as they are.
            </p>
          </div>
          <Button type="submit" size="sm" disabled={busy}>
            Save SMS sender
          </Button>
        </form>
      </div>
    </SectionCard>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/automation/providers">
      <ProvidersPage />
    </OpsGuard>
  );
}
