import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ReceivingAccountSelect } from "@/components/payments/ReceivingAccountSelect";

type TillClaim = {
  claim_id: string;
  delivery_order_id: string;
  order_number: string;
  receipt_code: string;
  order_total: number;
  payment_status: string;
  claim_status: string;
  submitted_at: string;
  branch_id: string;
};

type RpcResult = {
  ok?: boolean;
  reason?: string;
  detail?: string;
  receipt_number?: string;
  payment_result?: {
    ok?: boolean;
    receipt_number?: string;
    journal_number?: string;
  };
};

type RpcClient = {
  rpc: (
    name: string,
    args?: Record<string, unknown>
  ) => Promise<{
    data: unknown;
    error: { message: string } | null;
  }>;
};

const rpcClient = supabase as unknown as RpcClient;

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Operation failed.";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value.trim()
  );
}

function money(value: number): string {
  return `KES ${Number(value || 0).toLocaleString("en-KE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function DeliveryTillVerification() {
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<TillClaim | null>(null);
  const [amount, setAmount] = useState("");
  const [merchantTill, setMerchantTill] = useState("");
  const [receivingAccount, setReceivingAccount] = useState("");
  const [evidence, setEvidence] = useState("");
  const [confirmedAgainstMerchant, setConfirmedAgainstMerchant] =
    useState(false);

  const queue = useQuery({
    queryKey: ["finance", "delivery-mpesa-till-claims"],
    queryFn: async (): Promise<TillClaim[]> => {
      const { data, error } = await rpcClient.rpc(
        "neo_delivery_mpesa_till_claim_queue"
      );

      if (error) throw new Error(error.message);

      const payload = data as unknown;

      let items: unknown[];

      if (Array.isArray(payload)) {
        items = payload;
      } else if (
        payload !== null &&
        typeof payload === "object"
      ) {
        const response = payload as Record<string, unknown>;

        if (response["ok"] === false) {
          throw new Error(
            String(
              response["detail"] ??
              response["reason"] ??
              "Claim queue failed."
            )
          );
        }

        const collection =
          response["claims"] ??
          response["items"] ??
          response["queue"] ??
          response["data"] ??
          response["rows"];

        if (!Array.isArray(collection)) {
          throw new Error(
            "Unexpected Till claim queue structure."
          );
        }

        items = collection;
      } else {
        throw new Error(
          "Invalid Till claim queue response."
        );
      }

      return items.map((item) => {
        if (
          item === null ||
          typeof item !== "object" ||
          Array.isArray(item)
        ) {
          throw new Error("Invalid Till claim record.");
        }

        const row = item as Record<string, unknown>;

        const claim: TillClaim = {
          claim_id: String(row["claim_id"] ?? row["id"] ?? ""),
          delivery_order_id: String(row["delivery_order_id"] ?? ""),
          order_number: String(row["order_number"] ?? ""),
          receipt_code: String(row["receipt_code"] ?? ""),
          order_total: Number(
            row["order_total"] ?? row["grand_total"] ?? NaN
          ),
          payment_status: String(
            row["payment_status"] ?? "awaiting-verification"
          ),
          claim_status: String(
            row["claim_status"] ?? row["status"] ?? "submitted"
          ),
          submitted_at: String(row["submitted_at"] ?? ""),
          branch_id: String(row["branch_id"] ?? ""),
        };

        if (
          !isUuid(claim.claim_id) ||
          !isUuid(claim.delivery_order_id) ||
          !claim.receipt_code ||
          !Number.isFinite(claim.order_total)
        ) {
          throw new Error(
            "Till claim is missing required information."
          );
        }

        return claim;
      });
    },
    refetchInterval: 30000,
    retry: 1,
  });

  const approve = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("Select a payment claim.");

      if (!confirmedAgainstMerchant) {
        throw new Error(
          "Confirm that you independently checked the merchant statement."
        );
      }

      const verifiedAmount = Number(amount);

      if (
        !Number.isFinite(verifiedAmount) ||
        verifiedAmount <= 0 ||
        !Number.isInteger(verifiedAmount * 100)
      ) {
        throw new Error("Enter a valid verified amount.");
      }

      if (!merchantTill.trim()) {
        throw new Error("Enter the merchant Till number.");
      }

      if (!isUuid(receivingAccount)) {
        throw new Error("Select a valid receiving account ID.");
      }

      if (evidence.trim().length < 10) {
        throw new Error(
          "Record the merchant-side evidence used to verify this transaction."
        );
      }

      const { data, error } = await rpcClient.rpc(
        "neo_delivery_mpesa_till_claim_approve",
        {
          _claim: selected.claim_id,
          _verified_amount: verifiedAmount,
          _merchant_till: merchantTill.trim(),
          _verification_note: evidence.trim(),
          _receiving_account: receivingAccount.trim(),
        }
      );

      if (error) throw new Error(error.message);

      const result = data as RpcResult | null;

      if (!result?.ok || result.payment_result?.ok !== true) {
        throw new Error(
          result?.detail ??
            result?.reason ??
            "Finance approval did not confirm successful payment posting."
        );
      }

      return result;
    },

    onSuccess: async (result) => {
      toast.success(
        `Delivery payment posted. Receipt: ${
          result.payment_result?.receipt_number ?? "Recorded"
        }`
      );

      setSelected(null);
      setAmount("");
      setMerchantTill("");
      setReceivingAccount("");
      setEvidence("");
      setConfirmedAgainstMerchant(false);

      await queryClient.invalidateQueries({
        queryKey: ["finance"],
      });

      await queryClient.invalidateQueries({
        queryKey: ["delivery"],
      });
    },

    onError: (error) => toast.error(errorMessage(error)),
  });

  function selectClaim(claim: TillClaim) {
    setSelected(claim);
    setAmount("");
    setMerchantTill("");
    setReceivingAccount("");
    setEvidence("");
    setConfirmedAgainstMerchant(false);
  }

  return (
    <section className="space-y-4 rounded-xl border bg-card p-5">
      <div>
        <h2 className="text-lg font-semibold">
          M-PESA Till — Delivery Payment Verification
        </h2>

        <p className="mt-1 text-sm text-muted-foreground">
          Customer-submitted transaction codes are unverified claims.
          Only approve after checking the hotel's merchant records.
          Approval posts payment through NEØ's Delivery accounting process.
        </p>
      </div>

      {queue.isLoading ? (
        <p className="text-sm text-muted-foreground">
          Loading submitted Till references...
        </p>
      ) : queue.isError ? (
        <div className="space-y-2 rounded-lg border p-4">
          <p className="text-sm text-destructive">
            {errorMessage(queue.error)}
          </p>

          <Button
            size="sm"
            variant="outline"
            onClick={() => void queue.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : (queue.data ?? []).length === 0 ? (
        <p className="rounded-lg bg-muted p-4 text-sm text-muted-foreground">
          No customer-submitted M-PESA Till references are awaiting
          Finance verification.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="p-2">Delivery</th>
                <th className="p-2">M-PESA Code</th>
                <th className="p-2">Order Total</th>
                <th className="p-2">Payment</th>
                <th className="p-2">Action</th>
              </tr>
            </thead>

            <tbody>
              {(queue.data ?? []).map((claim) => (
                <tr key={claim.claim_id} className="border-b">
                  <td className="p-2 font-medium">
                    {claim.order_number}
                  </td>

                  <td className="p-2 font-mono">
                    {claim.receipt_code}
                  </td>

                  <td className="p-2">
                    {money(claim.order_total)}
                  </td>

                  <td className="p-2">
                    <span className="text-amber-700">
                      Awaiting merchant verification
                    </span>
                  </td>

                  <td className="p-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={approve.isPending}
                      onClick={() => selectClaim(claim)}
                    >
                      Review
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected ? (
        <div className="space-y-4 rounded-xl border bg-muted/30 p-4">
          <div>
            <h3 className="font-semibold">
              Verify {selected.order_number}
            </h3>

            <p className="text-sm text-muted-foreground">
              Customer-submitted reference:{" "}
              <strong>{selected.receipt_code}</strong>
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="till-verified-amount">
                Amount confirmed in merchant records (KES)
              </Label>

              <Input
                id="till-verified-amount"
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>

            <div>
              <Label htmlFor="till-merchant-number">
                Receiving merchant Till number
              </Label>

              <Input
                id="till-merchant-number"
                value={merchantTill}
                onChange={(e) => setMerchantTill(e.target.value)}
                placeholder="Official merchant Till"
              />
            </div>

            <div className="md:col-span-2">
              <ReceivingAccountSelect
                id="till-receiving-account"
                label="M-PESA receiving account"
                value={receivingAccount || null}
                onChange={(next) => setReceivingAccount(next ?? "")}
                disabled={approve.isPending}
                hint="Choose the configured account that actually received this M-PESA transaction. An explicit account selection is required."
              />
            </div>

            <div className="md:col-span-2">
              <Label htmlFor="till-verification-evidence">
                Independent merchant verification evidence
              </Label>

              <textarea
                id="till-verification-evidence"
                className="mt-1 min-h-24 w-full rounded-md border bg-background p-3 text-sm"
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
                placeholder="Record merchant statement reference, matching amount, transaction date and time, and verification details."
              />
            </div>
          </div>

          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={confirmedAgainstMerchant}
              onChange={(e) =>
                setConfirmedAgainstMerchant(e.target.checked)
              }
            />

            <span>
              I have independently verified the transaction code,
              recipient Till and amount against the hotel's
              merchant records. I understand approval records
              the payment and posts accounting entries.
            </span>
          </label>

          <div className="flex flex-wrap gap-3">
            <Button
              disabled={
                approve.isPending ||
                !confirmedAgainstMerchant ||
                !amount ||
                !merchantTill.trim() ||
                !isUuid(receivingAccount) ||
                evidence.trim().length < 10
              }
              onClick={() => approve.mutate()}
            >
              {approve.isPending
                ? "Verifying and posting..."
                : "Verify & Post Payment"}
            </Button>

            <Button
              variant="outline"
              disabled={approve.isPending}
              onClick={() => setSelected(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}


