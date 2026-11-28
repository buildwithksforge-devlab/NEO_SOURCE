import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

const db = supabase as any;

type Settlement = {
  payment_number:string;
  amount:number;
  paid_on:string | null;
  method:string;
  status:string;
};

type Position = {
  invoice_number:string;
  invoice_status?:string;
  review_status?:string;
  payable_recognized:boolean;
  currency?:string;
  invoice_amount?:number;
  settled_amount?:number;
  outstanding_amount?:number;
  payments?:Settlement[];
};

export function SupplierInvoicePaymentPosition({
  branchId,
  relationshipId,
  submissionId,
}:{
  branchId:string;
  relationshipId:string;
  submissionId:string;
}) {

  const [expanded,setExpanded] = useState(false);

  const query = useQuery({

    queryKey:[
      "supplier-invoice-payment-position",
      branchId,
      relationshipId,
      submissionId,
    ],

    enabled:Boolean(
      expanded &&
      branchId &&
      relationshipId &&
      submissionId
    ),

    gcTime:0,

    staleTime:0,

    queryFn:async ():Promise<Position> => {

      const {data,error} = await db.rpc(
        "neo_partner_supplier_invoice_payment_position",
        {
          _branch:branchId,
          _relationship:relationshipId,
          _submission:submissionId,
        }
      );

      if (error) throw new Error(error.message);

      if (
        !data ||
        typeof data.payable_recognized !== "boolean"
      ) {
        throw new Error(
          "Supplier financial position could not be confirmed."
        );
      }

      if (data.payable_recognized) {

        const amount = Number(data.invoice_amount);
        const paid = Number(data.settled_amount);
        const balance = Number(data.outstanding_amount);

        if (
          data.invoice_amount == null ||
          data.settled_amount == null ||
          data.outstanding_amount == null ||
          !/^[A-Z]{3}$/.test(data.currency ?? "") ||
          [amount,paid,balance].some(
            value=>!Number.isFinite(value) || value<0
          ) ||
          Math.abs(amount-paid-balance)>0.005 ||
          !Array.isArray(data.payments)
        ) {
          throw new Error(
            "Supplier financial position requires reconciliation."
          );
        }

        const payments = data.payments as Settlement[];

        if (
          payments.some(
            row=>
              row.status !== "paid" ||
              !Number.isFinite(Number(row.amount)) ||
              Number(row.amount)<=0
          ) ||
          Math.abs(
            payments.reduce(
              (sum,row)=>sum+Number(row.amount),0
            ) - paid
          )>0.005
        ) {
          throw new Error(
            "Supplier settlement evidence requires reconciliation."
          );
        }

      }

      return data as Position;
    },
  });

  const position = query.data;

  const money = (value:number | undefined) =>
    `${position?.currency ?? ""} ${
      Number(value).toLocaleString(
        undefined,
        {
          minimumFractionDigits:2,
          maximumFractionDigits:2,
        }
      )
    }`;

  return (
    <section className="mt-3 rounded-lg border border-border p-3">

      <button
        type="button"
        onClick={()=>setExpanded(value=>!value)}
        className="text-sm font-medium"
      >
        {expanded
          ? "Hide payment history"
          : "View payment history"}
      </button>

      {expanded && (

        <div className="mt-3 space-y-3">

          <button
            type="button"
            disabled={query.isFetching}
            onClick={()=>void query.refetch()}
            className="rounded border border-border px-3 py-1 text-xs"
          >
            Refresh payment position
          </button>

          {query.isFetching && (
            <p className="text-xs text-muted-foreground">
              Verifying financial position...
            </p>
          )}

          {query.isError && (
            <p role="alert" className="text-sm text-destructive">
              Payment position is currently unavailable
              or requires reconciliation. Contact Finance.
            </p>
          )}

          {query.isSuccess && !query.isFetching &&
            !position?.payable_recognized && (

              <div className="text-sm">

                <p>
                  Invoice status:{" "}
                  {position?.invoice_status ??
                    position?.review_status ??
                    "Awaiting verification"}
                </p>

                <p className="mt-1 text-xs text-muted-foreground">
                  A confirmed accounts payable obligation
                  has not yet been established.
                </p>

              </div>
            )}

          {query.isSuccess && !query.isFetching &&
            position?.payable_recognized && (

              <>

                <div className="grid gap-2 sm:grid-cols-3">

                  <div className="rounded border border-border p-3">
                    <p className="text-xs text-muted-foreground">
                      Approved invoice
                    </p>
                    <p className="font-semibold">
                      {money(position.invoice_amount)}
                    </p>
                  </div>

                  <div className="rounded border border-border p-3">
                    <p className="text-xs text-muted-foreground">
                      Confirmed payments
                    </p>
                    <p className="font-semibold">
                      {money(position.settled_amount)}
                    </p>
                  </div>

                  <div className="rounded border border-border p-3">
                    <p className="text-xs text-muted-foreground">
                      Outstanding
                    </p>
                    <p className="font-semibold">
                      {money(position.outstanding_amount)}
                    </p>
                  </div>

                </div>

                <h4 className="text-sm font-medium">
                  Confirmed settlement history
                </h4>

                {!position.payments?.length && (
                  <p className="text-xs text-muted-foreground">
                    No confirmed payments recorded.
                  </p>
                )}

                {position.payments?.map((row,index)=>(
                  <article
                    key={`${row.payment_number}:${index}`}
                    className="rounded border border-border p-3 text-sm"
                  >

                    <div className="flex justify-between gap-2">

                      <span className="font-medium">
                        {row.payment_number}
                      </span>

                      <span>
                        {money(row.amount)}
                      </span>

                    </div>

                    <p className="mt-1 text-xs text-muted-foreground">
                      {row.paid_on ?? "Date unavailable"}
                      {" — "}
                      {row.method}
                    </p>

                  </article>
                ))}

              </>
            )}

        </div>
      )}

    </section>
  );
}