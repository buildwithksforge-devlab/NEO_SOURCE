/**
 * One place that says what a payment method actually is.
 *
 * NEØ separates three different things that were previously blurred together:
 *
 *  - **Recorded tenders** — cash, card taken on the bank's own terminal, bank
 *    transfer, corporate credit, voucher, OTA prepaid and room/folio charge.
 *    The money moves outside NEØ and the entry here is the record of it. These
 *    are fully functional and post through the normal finance path.
 *  - **Provider-backed tenders** — M-Pesa (Safaricom Daraja) today, integrated
 *    card terminals and QR providers once an acquirer is connected. NEØ
 *    initiates the collection and waits for the provider's own confirmation;
 *    nothing is treated as received until that confirmation arrives.
 *  - **Provider configuration** — lives in one admin place per provider and is
 *    read, never re-entered, by operational screens.
 *
 * No screen may hard-code whether a provider is connected; it must read the
 * saved tenant configuration through `usePaymentReadiness()` (all methods) or
 * `useMpesaCollectionStatus()` (M-Pesa only).
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

export type PaymentMethodKind = "recorded" | "provider";

export type PaymentMethodDefinition = {
  value: string;
  label: string;
  kind: PaymentMethodKind;
  /** Set for provider-backed methods only. */
  provider?: "mpesa" | "card_terminal" | "qr_payments";
  /** Where an administrator sets this provider up. */
  configPath?: string;
  hint: string;
};

/** The canonical catalogue every operational payment surface should describe. */
export const PAYMENT_METHOD_CATALOGUE: readonly PaymentMethodDefinition[] = [
  { value: "cash", label: "Cash", kind: "recorded", hint: "Physically received into a till and receipted." },
  { value: "card", label: "Card terminal", kind: "recorded", hint: "Taken on the bank's own terminal and recorded here with its reference." },
  { value: "bank-transfer", label: "Bank transfer", kind: "recorded", hint: "Recorded against the bank account and matched at reconciliation." },
  { value: "corporate-credit", label: "Corporate credit", kind: "recorded", hint: "Billed to the company account under its credit terms." },
  { value: "voucher", label: "Voucher", kind: "recorded", hint: "Redeemed against a voucher reference." },
  { value: "ota-prepaid", label: "OTA prepaid / VCC", kind: "recorded", hint: "Already collected by the travel agent; recorded for settlement." },
  {
    value: "room-charge",
    label: "Room / folio charge",
    kind: "recorded",
    // Only offered where a guest folio exists to carry the charge.
    hint: "Posted to the guest folio and settled at departure.",
  },
  {
    value: "mpesa",
    label: "M-Pesa",
    kind: "provider",
    provider: "mpesa",
    configPath: "/admin/payments-mpesa",
    hint: "NEØ sends the prompt and waits for Safaricom to confirm it.",
  },
  {
    value: "card-terminal",
    label: "Card terminal (integrated)",
    kind: "provider",
    provider: "card_terminal",
    configPath: "/platform/integrations",
    hint: "A supported terminal or acquirer returns the authorisation and settlement reference. A browser cannot read a physical card on its own.",
  },
  {
    value: "qr",
    label: "QR payment",
    kind: "provider",
    provider: "qr_payments",
    configPath: "/platform/integrations",
    hint: "A QR provider must confirm the payment before it is treated as received.",
  },
] as const;

/**
 * Older spellings that exist in saved records and must keep reading correctly.
 *
 * Historical rows are never rewritten — a payment taken in August stays exactly
 * as it was recorded. This map only decides how an old value is *read*: which
 * canonical method it counts as in a register, a report or a reconciliation.
 * New writes always use the canonical value on the left-hand side.
 */
export const LEGACY_PAYMENT_METHOD_ALIASES: Readonly<Record<string, string>> = {
  bank_transfer: "bank-transfer",
  banktransfer: "bank-transfer",
  eft: "bank-transfer",
  "debit-card": "card",
  debit_card: "card",
  "credit-card": "card",
  credit_card: "card",
  card_terminal: "card-terminal",
  "card-on-delivery": "card",
  corporate_credit: "corporate-credit",
  "city-ledger": "corporate-credit",
  city_ledger: "corporate-credit",
  ota_vcc: "ota-prepaid",
  "ota-vcc": "ota-prepaid",
  ota_prepaid: "ota-prepaid",
  "room_charge": "room-charge",
  "cash-on-delivery": "cash",
  cod: "cash",
  "mobile-money": "mpesa",
  mobile_money: "mpesa",
  "m-pesa": "mpesa",
  qr_code: "qr",
  "qr-code": "qr",
};

/** The canonical method a stored value counts as. Unknown values pass through. */
export function normalisePaymentMethod(value: string | null | undefined): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  return LEGACY_PAYMENT_METHOD_ALIASES[raw] ?? raw;
}

export function paymentMethod(value: string): PaymentMethodDefinition | undefined {
  const canonical = normalisePaymentMethod(value);
  return PAYMENT_METHOD_CATALOGUE.find((m) => m.value === canonical);
}

/** Display name for any stored value, old or new. */
export function paymentMethodLabel(value: string | null | undefined): string {
  const canonical = normalisePaymentMethod(value);
  if (!canonical) return "—";
  const known = PAYMENT_METHOD_CATALOGUE.find((m) => m.value === canonical);
  if (known) return known.label;
  return canonical.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export type MpesaCollectionStatus = {
  ready: boolean;
  configured: boolean;
  enabled: boolean;
  environment?: string;
  missing?: string[];
  config_path?: string;
  last_check_at?: string | null;
  last_check_status?: string | null;
  reason?: string | null;
};

/**
 * Whether this workspace can send an M-Pesa prompt right now. Returns no
 * credential of any kind — only the booleans, the missing field names and a
 * plain-language reason.
 */
export function useMpesaCollectionStatus() {
  return useQuery<MpesaCollectionStatus>({
    queryKey: ["mpesa-collection-status"],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_mpesa_collection_status");
      if (error) throw new Error(error.message);
      return (data ?? { ready: false, configured: false, enabled: false }) as MpesaCollectionStatus;
    },
  });
}

export type PaymentReadiness = {
  method: string;
  label: string;
  kind: PaymentMethodKind;
  provider_code?: string;
  ready: boolean;
  configured?: boolean;
  enabled?: boolean;
  environment?: string | null;
  missing?: string[];
  reason?: string | null;
  hint?: string;
  config_path?: string;
  last_test?: { at?: string; status?: string; detail?: string | null } | null;
  last_test_at?: string | null;
  last_test_status?: string | null;
  sandbox_test_passed_at?: string | null;
  production_approved_at?: string | null;
  security_review_passed_at?: string | null;
  last_error?: string | null;
};

/**
 * Every tender this workspace can take right now, with the reason when it
 * cannot. This is the single readiness source for POS, front office, events and
 * any other payment-taking screen.
 */
export function usePaymentReadiness() {
  return useQuery<PaymentReadiness[]>({
    queryKey: ["payment-readiness"],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_payment_readiness");
      if (error) throw new Error(error.message);
      return (data ?? []) as PaymentReadiness[];
    },
  });
}
