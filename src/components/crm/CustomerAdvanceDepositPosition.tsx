import { CustomerDepositRefunds } from "@/components/crm/CustomerDepositRefunds";
import { CustomerDepositTransactions } from "@/components/crm/CustomerDepositTransactions";
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

import {
  summarizeCustomerDeposits,
  type CustomerAdvanceDeposit,
} from "@/lib/customer-advance-deposits";

const db = supabase as any;

export function CustomerAdvanceDepositPosition({
  customerId,
}: {
  customerId: string;
}) {
  const { organizationId,user,can } = useAuth();

  const { branchId } = useActivePropertyFilter();

  const permitted =
    can("finance","view") ||
    can("finance","ar.allocate_receipt");

  const query = useQuery({
    queryKey: [
      "customer-advance-deposit-position",
      organizationId,
      user?.id,
      branchId,
      customerId,
    ],

    enabled: Boolean(
      permitted &&
      organizationId &&
      user?.id &&
      branchId &&
      customerId
    ),

    queryFn: async () => {
      const {data,error} = await db.rpc(
        "neo_customer_advance_deposit_position",
        {
          _branch:branchId,
          _customer:customerId,
        }
      );

      if (error) throw new Error(error.message);

      if (!Array.isArray(data)) {
        throw new Error("Invalid deposit register.");
      }

      const deposits = data as CustomerAdvanceDeposit[];

      return {
        deposits,
        totals:summarizeCustomerDeposits(deposits),
      };
    },
  });

  if (!permitted) return null;

  return (
    <section className="rounded-xl border border-border bg-card p-4">

      <h3 className="font-semibold">
        Customer advance deposits
      </h3>

      <p className="mt-1 text-xs text-muted-foreground">
        Advance funds are tracked separately from
        invoice repayments and recognised revenue.
      </p>

      {!branchId && (
        <p className="mt-3 text-sm">
          Select a property to view its deposit position.
        </p>
      )}

      {branchId && (
        <button
          type="button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
          className="mt-3 rounded border border-border px-3 py-1 text-xs"
        >
          Refresh deposits
        </button>
      )}

      {query.isLoading && (
        <p className="mt-3 text-sm">
          Loading deposit position...
        </p>
      )}

      {query.isError && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          Deposit position could not be verified.
        </p>
      )}

      {can("finance","ar.allocate_receipt") &&
        organizationId &&
        branchId &&
        user?.id && (
          <CustomerDepositTransactions
            key={`${organizationId}:${branchId}:${user.id}:${customerId}`}
            customerId={customerId}
            branchId={branchId}
            organizationId={organizationId}
            actorId={user.id}
          />
      )}

      {organizationId && branchId && user?.id && (
        <CustomerDepositRefunds
          key={`${organizationId}:${branchId}:${user.id}:${customerId}:refunds`}
          customerId={customerId}
          branchId={branchId}
          organizationId={organizationId}
          actorId={user.id}
        />
      )}

      {query.isSuccess && (
        <div className="mt-4 space-y-3">

          {query.data.totals.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No registered customer advance deposits.
            </p>
          )}

          {query.data.totals.map((row) => (
            <div
              key={row.currency}
              className="grid gap-3 sm:grid-cols-4"
            >
              {[
                ["Received",row.received],
                ["Allocated",row.allocated],
                ["Refunded",row.refunded],
                ["Available",row.available],
              ].map(([label,value]) => (
                <div
                  key={String(label)}
                  className="rounded-lg border border-border p-3"
                >
                  <p className="text-xs text-muted-foreground">
                    {label}
                  </p>

                  <p className="mt-1 font-semibold">
                    {row.currency}
                    {" "}
                    {Number(value).toLocaleString(
                      undefined,
                      {
                        minimumFractionDigits:2,
                        maximumFractionDigits:2,
                      }
                    )}
                  </p>
                </div>
              ))}
            </div>
          ))}

          {query.data.deposits.map((row) => (
            <article
              key={row.id}
              className="rounded-lg border border-border p-3 text-sm"
            >
              <p className="font-medium">
                {row.receipt_number}
              </p>

              <p>
                Available: {row.currency}
                {" "}
                {Number(row.available_amount).toFixed(2)}
              </p>

              <p className="text-xs text-muted-foreground">
                {new Date(row.received_at).toLocaleString()}
              </p>
            </article>
          ))}

        </div>
      )}

    </section>
  );
}