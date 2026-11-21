/**
 * The one honest answer to "what can we take payment with right now?".
 *
 * It reads the workspace's saved configuration through `usePaymentReadiness()`
 * and shows each tender's real state: recorded tenders are always available,
 * provider-backed tenders are only available once their provider is configured,
 * tested and switched on. Where a provider is not ready it says why and links
 * to the one place it is set up.
 */
import { Link } from "@tanstack/react-router";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { LoadingState } from "@/components/common/StateSystem";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { canAccessPath } from "@/lib/nav-permissions";
import {
  paymentAdapterCapabilities,
  usePaymentReadiness,
  type PaymentReadiness,
} from "@/lib/payment-methods";

function tone(row: PaymentReadiness): "success" | "warning" | "default" {
  if (row.ready) return "success";
  return row.kind === "provider" ? "warning" : "default";
}

function state(row: PaymentReadiness): string {
  if (row.kind === "recorded") return row.ready ? "Available" : "Unavailable";
  if (row.ready) return "Collection enabled";
  if (row.last_test?.status === "failed" || row.last_test_status === "failed") return "Verification failed";
  if (row.configured) return row.enabled ? "Not tested" : "Switched off";
  return "Not configured";
}

export function PaymentReadinessPanel({ title = "Payment methods" }: { title?: string }) {
  const readiness = usePaymentReadiness();
  const { can, isAdmin } = useAuth();
  const rows = readiness.data ?? [];

  return (
    <SectionCard
      title={title}
      description="Recorded tenders are taken outside NEØ and entered here. Provider-backed tenders need their provider configured before they can be used."
      actions={<Button variant="outline" size="sm" disabled={readiness.isFetching} onClick={() => void readiness.refetch()}>Refresh status</Button>}
    >
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        {isAdmin || canAccessPath(can, "/admin/delivery-settings") ? <Link to="/admin/delivery-settings" className="underline underline-offset-2">Delivery checkout methods</Link> : null}
        {isAdmin || canAccessPath(can, "/platform/integrations") ? <Link to="/platform/integrations" className="underline underline-offset-2">Card and QR gateway setup</Link> : null}
        {isAdmin || canAccessPath(can, "/admin/payments-mpesa") ? <Link to="/admin/payments-mpesa" className="underline underline-offset-2">M-Pesa setup</Link> : null}
      </div>
      {readiness.isLoading ? (
        <LoadingState variant="table" rows={4} />
      ) : readiness.isError || rows.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">Saved payment readiness could not be verified. Refresh status to try again.</p>
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          {rows.map((row) => (
            <li
              key={row.method}
              className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-card/40 p-3 text-sm"
            >
              <span className="min-w-0">
                <span className="block font-medium">{row.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {row.reason ?? row.hint ?? ""}
                </span>
                {row.kind === "provider" && paymentAdapterCapabilities(row.method)?.refundExecution === "external-confirmation-only" ? (
                  <span className="block text-xs text-muted-foreground">
                    Finance can record a completed external POS refund. The provider’s refund eligibility and limits require separate verification.
                  </span>
                ) : null}
                {row.kind === "provider" && row.config_path && (isAdmin || canAccessPath(can, row.config_path)) ? (
                  <Link to={row.config_path} className="mt-1 inline-block text-xs underline underline-offset-2">
                    {row.ready ? "Review setup" : "Set this up"}
                  </Link>
                ) : null}
              </span>
              <span className="shrink-0 space-y-1 text-right">
                <StatusPill tone={tone(row)}>{state(row)}</StatusPill>
                {row.environment && row.kind === "provider" ? (
                  <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                    {row.environment}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
