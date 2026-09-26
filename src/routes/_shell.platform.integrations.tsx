import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { KeyRound, Loader2, Plug, RefreshCcw } from "lucide-react";
import { runProviderTest, testMpesaCallbackEndpoint } from "@/lib/integrations.functions";
import { SectionCard, StatCard } from "@/components/common/DataDisplay";
import { ProviderDeclarationDialog } from "@/components/platform/ProviderDeclarationDialog";
import {
  AccessDenied,
  EmptyState,
  EvidenceRow,
  TonePill,
  TruthNotice,
  formatDateTime,
  humanise,
  statusTone,
} from "@/components/platform/PlatformShared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import {
  useIntegrationConnections,
  useIntegrationEvents,
  useIntegrationProviders,
  useIntegrationTestRuns,
  useDeclareProvider,
  useSaveConnection,
  useWebhookReceipts,
} from "@/lib/platform-data";
import {
  INTEGRATION_STATUS_LABELS,
  INTEGRATION_STATUS_TONE,
  connectionRequirements,
  derivedConnectionStatus,
  isCredentialExpiring,
  maskIdentifier,
} from "@/lib/platform";

export const Route = createFileRoute("/_shell/platform/integrations")({
  component: IntegrationCentre,
});

type Row = Record<string, any>;

const ENVIRONMENTS = ["sandbox", "staging", "production"];

function IntegrationCentre() {
  const { can, isAdmin } = useAuth();
  const providers = useIntegrationProviders();
  const connections = useIntegrationConnections();
  const events = useIntegrationEvents();
  const receipts = useWebhookReceipts();
  const testRuns = useIntegrationTestRuns();
  const save = useSaveConnection();
  const [active, setActive] = useState<Row | null>(null);
  const [declaring, setDeclaring] = useState<Row | null>(null);
  const [declaringNew, setDeclaringNew] = useState(false);
  const declare = useDeclareProvider();

  // A test is run for real and its outcome persisted by the database routine.
  // Nothing here can claim a pass that did not happen.
  const runTest = useServerFn(runProviderTest);
  const runCallbackTest = useServerFn(testMpesaCallbackEndpoint);
  const [testing, setTesting] = useState<string | null>(null);
  const test = useMutation({
    mutationFn: async (input: { providerCode: string; callback?: boolean }) =>
      input.callback ? runCallbackTest({ data: undefined as never }) : runTest({ data: { providerCode: input.providerCode } }),
    onSuccess: (result) => {
      if (result.status === "passed") toast.success(result.detail);
      else if (result.status === "unsupported") toast.info(result.detail);
      else toast.error(result.detail);
      void connections.refetch();
      void testRuns.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setTesting(null),
  });

  const canView = can("integrations", "view");
  const canEdit = can("integrations", "edit");

  const byProvider = useMemo(() => {
    const map = new Map<string, Row>();
    for (const c of connections.data ?? []) map.set(String(c["provider_code"]), c);
    return map;
  }, [connections.data]);

  if (!canView) {
    return (
      <AccessDenied
        title="Integration Centre is restricted"
        body="Provider connections expose commercial and compliance configuration. Ask an administrator to grant the integrations module to your role."
      />
    );
  }

  const list = providers.data ?? [];
  const connected = list.filter((p) => {
    const c = byProvider.get(String(p["code"]));
    return c ? derivedConnectionStatus(c as never) === "connected" : false;
  });
  const pendingEvents = (events.data ?? []).filter((e) =>
    ["pending", "retrying"].includes(String(e["status"])),
  );
  const deadLetters = (events.data ?? []).filter((e) => String(e["status"]) === "dead_letter");

  return (
    <div className="space-y-6">
      <TruthNotice>
        Credentials are never stored in the application database — only the names of the server-side
        secrets and a masked identifier. A provider is marked Connected only when secrets exist, a
        recorded test actually passed, security review passed, production use was approved, and it is
        enabled for this property. "Run test" exercises the provider for real where that is safe and
        records the outcome; where no non-destructive test exists it says so instead of claiming a pass.
        M-Pesa credentials are held per workspace in Administration → M-Pesa payments.
      </TruthNotice>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Providers in catalogue" value={String(list.length)} />
        <StatCard label="Verified connections" value={String(connected.length)} />
        <StatCard label="Queued outbound events" value={String(pendingEvents.length)} />
        <StatCard label="Dead-lettered events" value={String(deadLetters.length)} />
      </div>

      {isAdmin ? (
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => {
              setDeclaring(null);
              setDeclaringNew(true);
            }}
          >
            <Plug className="mr-2 size-3.5" />
            Declare a provider
          </Button>
        </div>
      ) : null}


      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {list.map((p) => {
          const c = byProvider.get(String(p["code"]));
          const status = c ? derivedConnectionStatus(c as never) : "not_configured";
          const reqs = c
            ? connectionRequirements(c as never)
            : connectionRequirements({ status: "not_configured", enabled: false });
           const expiring = isCredentialExpiring(c?.["credentials_expire_at"]);
           const declared = String(p["declaration_status"] ?? "draft") === "declared";
           const capabilities = (p["capabilities"] as string[] | null) ?? [];
           const declaredRequirements =
             (p["connection_requirements"] as Array<Record<string, any>> | null) ?? [];
          return (
            <Card key={String(p["id"])} className="surface-panel">
              <CardContent className="space-y-3 py-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-foreground">{String(p["name"])}</p>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      {humanise(String(p["category"]))}
                    </p>
                  </div>
                  <TonePill tone={INTEGRATION_STATUS_TONE[status]}>
                    {INTEGRATION_STATUS_LABELS[status]}
                  </TonePill>
                </div>
                 <p className="text-sm text-muted-foreground">{String(p["purpose"] ?? "")}</p>
                 {capabilities.length > 0 ? (
                   <div className="flex flex-wrap gap-1">
                     {capabilities.map((cap) => (
                       <Badge key={cap} variant="secondary" className="text-[11px]">
                         {humanise(cap)}
                       </Badge>
                     ))}
                   </div>
                 ) : null}
                 {declaredRequirements.length > 0 ? (
                   <div className="rounded-lg border border-border/70 p-2">
                     <p className="text-xs font-medium text-foreground">
                       Declared before connecting
                     </p>
                     <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                       {declaredRequirements.map((r, index) => (
                         <li key={String(r["key"] ?? index)}>
                           {String(r["label"] ?? r["key"])} · {String(r["kind"] ?? "setting")}
                         </li>
                       ))}
                     </ul>
                   </div>
                 ) : (
                   <p className="text-xs text-muted-foreground">
                     This provider has not declared what it needs before a connection.
                   </p>
                 )}
                 <ul className="space-y-1">
                   {reqs.map((r) => (
                     <EvidenceRow key={r.key} label={r.label} met={r.met} />
                   ))}
                 </ul>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">
                    {humanise(String(c?.["environment"] ?? "sandbox"))}
                  </Badge>
                  {p["requires_partner_approval"] ? (
                    <Badge variant="outline">Partner approval required</Badge>
                  ) : null}
                  {p["supports_webhooks"] ? <Badge variant="outline">Webhooks</Badge> : null}
                  {expiring ? <Badge variant="destructive">Credentials expiring</Badge> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  Identifier {maskIdentifier(c?.["masked_identifier"])} · Last success{" "}
                  {formatDateTime(c?.["last_success_at"])}
                </p>
                {canEdit ? (
                  <div className="flex gap-2 pt-1">
                    {String(p["code"]) === "daraja" ? (
                      // M-Pesa is set up in one place only, so credentials are
                      // never entered twice.
                      <Button size="sm" variant="secondary" asChild>
                        <Link to="/admin/payments-mpesa">
                          <Plug className="mr-2 size-3.5" />
                          Open M-Pesa settings
                        </Link>
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!declared}
                        title={
                          declared
                            ? undefined
                            : "This provider has not declared its category, capabilities and requirements yet"
                        }
                        onClick={() => setActive({ provider: p, connection: c ?? null })}
                      >
                        <Plug className="mr-2 size-3.5" />
                        Configure
                      </Button>
                    )}
                    {isAdmin ? (
                      <Button size="sm" variant="ghost" onClick={() => setDeclaring(p)}>
                        {declared ? "Edit declaration" : "Declare"}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={test.isPending}
                      onClick={() => {
                        setTesting(String(p["code"]));
                        test.mutate({ providerCode: String(p["code"]) });
                      }}
                    >
                      {testing === String(p["code"]) ? (
                        <Loader2 className="mr-2 size-3.5 animate-spin" />
                      ) : (
                        <RefreshCcw className="mr-2 size-3.5" />
                      )}
                      Run test
                    </Button>
                    {String(p["code"]) === "daraja" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={test.isPending}
                        onClick={() => {
                          setTesting("daraja-callback");
                          test.mutate({ providerCode: "daraja", callback: true });
                        }}
                      >
                        Test callback
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <SectionCard
        title="Outbound integration events"
        description="Every outbound message is queued with an idempotency key, retried with backoff and dead-lettered after the final attempt."
      >
        {(events.data ?? []).length === 0 ? (
          <EmptyState
            title="No integration events yet"
            body="Events appear here once a connected provider is used by an operational module."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Next retry</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(events.data ?? []).slice(0, 25).map((e) => (
                  <TableRow key={String(e["id"])}>
                    <TableCell>{humanise(String(e["provider_code"]))}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {String(e["event_type"])}
                    </TableCell>
                    <TableCell>
                      <TonePill tone={statusTone(String(e["status"]))}>
                        {humanise(String(e["status"]))}
                      </TonePill>
                    </TableCell>
                    <TableCell>{`${e["attempt_count"]} / ${e["max_attempts"]}`}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(e["next_retry_at"] as string)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(e["created_at"] as string)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Verified webhook receipts"
          description="Only signature-verified callbacks are processed; replays are recorded and ignored."
        >
          {(receipts.data ?? []).length === 0 ? (
            <EmptyState
              title="No webhooks received"
              body="Inbound provider callbacks will be listed here once a provider is live."
            />
          ) : (
            <ul className="space-y-2 text-sm">
              {(receipts.data ?? []).slice(0, 10).map((r) => (
                <li
                  key={String(r["id"])}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                >
                  <span className="text-foreground">
                    {humanise(String(r["provider_code"]))} · {String(r["event_type"] ?? "event")}
                  </span>
                  <TonePill tone={r["signature_verified"] ? "success" : "danger"}>
                    {r["signature_verified"] ? "Signature verified" : "Rejected"}
                  </TonePill>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Connection test history"
          description="Every sandbox and production test attempt is recorded with its outcome."
        >
          {(testRuns.data ?? []).length === 0 ? (
            <EmptyState
              title="No tests recorded"
              body="Record a test from a provider card to build the verification trail."
            />
          ) : (
            <ul className="space-y-2 text-sm">
              {(testRuns.data ?? []).slice(0, 10).map((t) => (
                <li
                  key={String(t["id"])}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                >
                  <span className="text-foreground">
                    {humanise(String(t["provider_code"]))} · {humanise(String(t["test_type"]))} ·{" "}
                    {humanise(String(t["environment"]))}
                  </span>
                  <TonePill tone={statusTone(String(t["status"]))}>
                    {humanise(String(t["status"]))}
                  </TonePill>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <ProviderDeclarationDialog
        open={Boolean(declaring) || declaringNew}
        existing={declaring}
        pending={declare.isPending}
        onClose={() => {
          setDeclaring(null);
          setDeclaringNew(false);
        }}
        onSubmit={(declaration) =>
          declare.mutate(declaration, {
            onSuccess: () => {
              setDeclaring(null);
              setDeclaringNew(false);
              void providers.refetch();
            },
          })
        }
      />

      <ConfigureDialog
        record={active}
        onClose={() => setActive(null)}
        onSave={(values) => {
          save.mutate(values, { onSuccess: () => setActive(null) });
        }}
      />
    </div>
  );
}

function ConfigureDialog({
  record,
  onClose,
  onSave,
}: {
  record: Row | null;
  onClose: () => void;
  onSave: (values: Row) => void;
}) {
  const provider = record?.["provider"] as Row | undefined;
  const connection = record?.["connection"] as Row | null | undefined;
  const [environment, setEnvironment] = useState("sandbox");
  const [enabled, setEnabled] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [notes, setNotes] = useState("");
  const [securityReviewed, setSecurityReviewed] = useState(false);
  const [productionApproved, setProductionApproved] = useState(false);
  const [secretsStored, setSecretsStored] = useState(false);
  const [initialised, setInitialised] = useState<string | null>(null);
  // A card terminal or QR app is reached over one contract: an address, an
  // optional merchant/terminal identity and the name of the key held server-side.
  const [endpointUrl, setEndpointUrl] = useState("");
  const [merchantId, setMerchantId] = useState("");
  const [terminalId, setTerminalId] = useState("");
  const [secretName, setSecretName] = useState("");

  if (provider && initialised !== String(provider["code"])) {
    setInitialised(String(provider["code"]));
    setEnvironment(String(connection?.["environment"] ?? "sandbox"));
    setEnabled(Boolean(connection?.["enabled"]));
    setIdentifier(String(connection?.["masked_identifier"] ?? ""));
    setNotes(String(connection?.["verification_notes"] ?? ""));
    setSecurityReviewed(Boolean(connection?.["security_review_passed_at"]));
    setProductionApproved(Boolean(connection?.["production_approved_at"]));
    setSecretsStored(
      Array.isArray(connection?.["secret_names"]) && connection!["secret_names"].length > 0,
    );
    const cfg = (connection?.["configuration"] ?? {}) as Record<string, unknown>;
    setEndpointUrl(String(cfg["endpoint_url"] ?? ""));
    setMerchantId(String(cfg["merchant_id"] ?? ""));
    setTerminalId(String(cfg["terminal_id"] ?? ""));
    setSecretName(String(cfg["secret_name"] ?? ""));
  }

  const isGateway =
    provider?.["code"] === "card_terminal" || provider?.["code"] === "qr_payments";
  /** A gateway only counts as connected once NEØ has somewhere to send the request. */
  const gatewayReady = !isGateway || endpointUrl.trim().startsWith("https://");
  const connectorSecretNameValid =
    !secretName.trim() || /^NEO_CONNECTOR_[A-Z0-9_]{1,80}$/.test(secretName.trim());

  const requiredSecrets = (provider?.["required_secret_names"] as string[] | undefined) ?? [];

  return (
    <Dialog
      open={Boolean(record)}
      onOpenChange={(open) => (!open ? (onClose(), setInitialised(null)) : null)}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{provider ? String(provider["name"]) : "Configure connection"}</DialogTitle>
          <DialogDescription>
            Record how this provider is configured. Secret values are stored server-side and are
            never entered or shown here.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border border-border p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-foreground">
              <KeyRound className="size-4" /> Required server-side secrets
            </p>
            {requiredSecrets.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                This provider needs no additional secrets.
              </p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                {requiredSecrets.map((s) => (
                  <li key={s} className="font-mono text-xs">
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2">
            <Label>Environment</Label>
            <Select value={environment} onValueChange={setEnvironment}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENVIRONMENTS.map((e) => (
                  <SelectItem key={e} value={e}>
                    {humanise(e)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isGateway ? (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <p className="text-sm font-medium text-foreground">Processor request address</p>
              <p className="text-xs text-muted-foreground">
                NEØ posts each collection to this address and the processor answers on the
                callback address it is given. Until an address is saved, this tender stays
                unavailable at every till.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="endpoint">Request address (https)</Label>
                <Input
                  id="endpoint"
                  value={endpointUrl}
                  onChange={(e) => setEndpointUrl(e.target.value)}
                  placeholder="https://gateway.example.com/v1/payments"
                />
                {environment === "sandbox" ? (
                  <p className="text-xs text-muted-foreground">
                    No terminal yet? Use the built-in test terminal to rehearse the whole
                    payment before an acquirer is signed:{" "}
                    <button
                      type="button"
                      className="font-mono underline underline-offset-2"
                      onClick={() =>
                        setEndpointUrl(
                          `${window.location.origin}/api/public/payments/simulator/terminal`,
                        )
                      }
                    >
                      use the test terminal
                    </button>
                    . It answers approved unless the amount ends .13 (declined), .01
                    (cancelled) or .77 (no answer). It moves no money.
                  </p>
                ) : null}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="merchant">Merchant ID</Label>
                  <Input id="merchant" value={merchantId} onChange={(e) => setMerchantId(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="terminal">Terminal ID</Label>
                  <Input id="terminal" value={terminalId} onChange={(e) => setTerminalId(e.target.value)} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="secret-name">Name of the saved key</Label>
                <Input
                  id="secret-name"
                  value={secretName}
                  onChange={(e) => setSecretName(e.target.value)}
                  placeholder="NEO_CONNECTOR_CARD_TERMINAL_API_KEY"
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  The name only. For security, generic gateway keys must use the
                  <span className="font-mono"> NEO_CONNECTOR_*</span> namespace; the value itself is saved separately and never shown here.
                </p>
                {!connectorSecretNameValid ? (
                  <p className="text-xs text-destructive">
                    Secret names must start with NEO_CONNECTOR_ and contain only capital letters, numbers and underscores.
                  </p>
                ) : null}
              </div>
              {!gatewayReady && endpointUrl.trim() ? (
                <p className="text-xs text-destructive">The address must start with https://</p>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="identifier">Masked account identifier</Label>
            <Input
              id="identifier"
              value={identifier}
              placeholder="e.g. shortcode ending 4321"
              onChange={(e) => setIdentifier(e.target.value)}
            />
          </div>

          <ToggleRow
            label="Credentials stored as server-side secrets"
            checked={secretsStored}
            onChange={setSecretsStored}
          />
          <ToggleRow
            label="Security review passed"
            checked={securityReviewed}
            onChange={setSecurityReviewed}
          />
          <ToggleRow
            label="Production use approved"
            checked={productionApproved}
            onChange={setProductionApproved}
          />
          <ToggleRow label="Enabled for this property" checked={enabled} onChange={setEnabled} />

          <div className="space-y-2">
            <Label htmlFor="notes">Verification notes</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={(enabled && !gatewayReady) || !connectorSecretNameValid}
              onClick={() =>
                onSave({
                  id: connection?.["id"],
                  provider_code: provider?.["code"],
                  environment,
                  enabled,
                  masked_identifier: identifier || null,
                  verification_notes: notes || null,
                  secret_names: secretsStored ? requiredSecrets : [],
                  security_review_passed_at: securityReviewed ? new Date().toISOString() : null,
                  production_approved_at: productionApproved ? new Date().toISOString() : null,
                  ...(isGateway
                    ? {
                        configuration: {
                          endpoint_url: endpointUrl.trim() || null,
                          merchant_id: merchantId.trim() || null,
                          terminal_id: terminalId.trim() || null,
                          secret_name: secretName.trim() || null,
                        },
                      }
                    : {}),
                  status: !enabled
                    ? "not_configured"
                    : isGateway
                      ? gatewayReady
                        ? "connected"
                        : "configured"
                      : "configured",
                })
              }
            >
              Save connection
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
      <span className="text-sm text-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

