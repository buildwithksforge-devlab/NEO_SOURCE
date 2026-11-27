import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

const db = supabase as any;

type OrderLine = {
  id:string;
  stock_item_id:string | null;
  description:string;
  quantity:number;
  unit_price:number;
  accepted_quantity:number;
  invoiced_quantity:number;
};

type CaptureLine = {
  id:string;
  quantity:string;
  unit_price:string;
  tax_amount:string;
};

type Context = {
  execution_enabled:boolean;
  submission_id:string;
  invoice_number:string;
  invoice_date:string;
  currency:string;
  declared_amount:number;
  receipts:{id:string;reference:string}[];
  order_lines:OrderLine[];
};

export function SupplierSubmissionCapture({
  submissionId,
}:{
  submissionId:string;
}) {

  const [receipt,setReceipt] = useState("");
  const [dueDate,setDueDate] = useState("");
  const [lines,setLines] = useState<CaptureLine[]>([]);

  const query = useQuery({
    queryKey:[
      "supplier-submission-capture-context",
      submissionId,
    ],

    queryFn:async ():Promise<Context> => {

      const {data,error} = await db.rpc(
        "neo_supplier_submission_capture_context",
        {
          _submission:submissionId,
        }
      );

      if (error) throw new Error(error.message);

      if (
        data?.submission_id !== submissionId ||
        !Array.isArray(data?.receipts) ||
        !Array.isArray(data?.order_lines)
      ) {
        throw new Error("Invalid invoice capture context.");
      }

      return data as Context;
    },

    gcTime:0,
    staleTime:0,
  });

  const context = query.data;

  // SUPPLIER_CAPTURE_EXECUTION_V1

  const queryClient = useQueryClient();

  const executionLock = useRef(false);

  const [captureMessage,setCaptureMessage] = useState("");

  const [capturedInvoice,setCapturedInvoice] =
    useState<string | null>(null);

  const capture = useMutation({

    retry:false,

    mutationFn:async () => {

      if (context?.execution_enabled !== true) {
        throw new Error(
          "Supplier invoice capture is not enabled."
        );
      }

      if (!context || !receipt || !matches || lines.length === 0) {
        throw new Error(
          "Complete the goods receipt and verified invoice lines."
        );
      }

      if (!context.receipts.some(r => r.id === receipt)) {
        throw new Error("Invalid goods receipt.");
      }

      if (new Set(lines.map(row => row.id)).size !== lines.length) {
        throw new Error("Duplicate invoice lines are not allowed.");
      }

      const payload = lines.map(row => {

        const original = context.order_lines.find(
          line => line.id === row.id
        );

        if (!original) {
          throw new Error("Original LPO line unavailable.");
        }

        const quantity = Number(row.quantity);
        const price = Number(row.unit_price);
        const tax = Number(row.tax_amount);

        const remaining =
          Number(original.accepted_quantity) -
          Number(original.invoiced_quantity);

        if (
          !Number.isFinite(quantity) ||
          !Number.isFinite(price) ||
          !Number.isFinite(tax) ||
          !Number.isFinite(remaining) ||
          quantity <= 0 ||
          quantity > remaining ||
          price < 0 ||
          tax < 0
        ) {
          throw new Error(
            "Invoice quantity or amount exceeds verified receipt evidence."
          );
        }

        return {

          purchase_order_line_id:original.id,

          stock_item_id:original.stock_item_id,

          description:original.description,

          quantity,

          unit_price:price,

          tax_amount:tax,

          discount_amount:0,

        };
      });

      const {data,error} = await db.rpc(

        "neo_supplier_submission_capture",

        {

          _submission:submissionId,

          _receipt:receipt,

          _lines:payload,

          _due_date:dueDate || null,

        }
      );

      if (error) {

        throw new Error(error.message);

      }

      if (data?.ok !== true || !data?.invoice_id) {

        throw new Error(
          "Capture outcome is unconfirmed. Reload the supplier submission before retrying."
        );

      }

      return data as {

        ok:boolean;

        invoice_id:string;

        already_captured?:boolean;

      };
    },

    onSuccess:async result => {

      setCapturedInvoice(result.invoice_id);

      setCaptureMessage(
        "Official draft invoice captured. Finance approval and matching are still required."
      );

      await queryClient.invalidateQueries();

    },

    onError:error => {

      setCaptureMessage(

        error instanceof Error

          ? error.message

          : "Invoice capture outcome could not be confirmed."

      );
    },

    onSettled:() => {

      executionLock.current = false;

    },
  });


  const lineTotal = (row:CaptureLine) => {

    const quantity = Number(row.quantity);
    const price = Number(row.unit_price);
    const tax = Number(row.tax_amount);

    if (
      !row.quantity.trim() ||
      !row.unit_price.trim() ||
      !row.tax_amount.trim() ||
      !Number.isFinite(quantity) ||
      !Number.isFinite(price) ||
      !Number.isFinite(tax) ||
      quantity <= 0 ||
      price < 0 ||
      tax < 0
    ) return NaN;

    return (
      Math.round(quantity * price * 100) +
      Math.round(tax * 100)
    ) / 100;
  };

  const total = lines.reduce(
    (sum,row) => sum + lineTotal(row),0
  );

  const matches = Boolean(
    context &&
    Number.isFinite(total) &&
    Math.round(total * 100) ===
      Math.round(Number(context.declared_amount) * 100)
  );

  function updateLine(
    id:string,
    key:"quantity" | "unit_price" | "tax_amount",
    value:string
  ) {
    setLines(current =>
      current.map(line =>
        line.id === id
          ? {...line,[key]:value}
          : line
      )
    );
  }

  if (query.isPending) {
    return <p>Loading purchase and receipt details...</p>;
  }

  if (query.isError || !context) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Invoice capture context could not be verified.
      </p>
    );
  }

  return (
    <section className="space-y-4 rounded-lg border border-border p-4">

      <h3 className="font-semibold">
        Prepare official supplier invoice
      </h3>

      <p className="text-sm">
        {context.invoice_number} — {context.currency}{" "}
        {Number(context.declared_amount).toFixed(2)}
      </p>

      <label className="block text-sm">

        Posted goods receipt

        <select
          value={receipt}
          onChange={e=>setReceipt(e.target.value)}
          className="mt-1 block w-full rounded border border-input bg-background p-2"
        >
          <option value="">Select receipt</option>

          {context.receipts.map(row=>(
            <option key={row.id} value={row.id}>
              {row.reference}
            </option>
          ))}
        </select>

      </label>

      {!context.receipts.length && (
        <p className="text-sm text-destructive">
          No posted goods receipt is available.
        </p>
      )}

      <label className="block text-sm">
        Due date
        <input
          type="date"
          min={context.invoice_date}
          value={dueDate}
          onChange={e=>setDueDate(e.target.value)}
          className="mt-1 block rounded border border-input bg-background p-2"
        />
      </label>

      <div className="space-y-2">

        {context.order_lines.map(item=>{

          const remaining = Math.max(
            Number(item.accepted_quantity) -
            Number(item.invoiced_quantity),0
          );

          return (
            <div
              key={item.id}
              className="flex items-center justify-between rounded border border-border p-2"
            >

              <div>
                <p className="text-sm">
                  {item.description}
                </p>

                <p className="text-xs text-muted-foreground">
                  Remaining accepted quantity: {remaining}
                </p>
              </div>

              <button
                type="button"
                disabled={
                  remaining <= 0 ||
                  lines.some(row=>row.id===item.id)
                }
                onClick={()=>setLines(current=>[
                  ...current,
                  {
                    id:item.id,
                    quantity:String(remaining),
                    unit_price:String(item.unit_price),
                    tax_amount:"0",
                  },
                ])}
                className="rounded border border-border px-3 py-1 text-xs disabled:opacity-40"
              >
                Add line
              </button>

            </div>
          );
        })}

      </div>

      {lines.map(row=>{

        const item = context.order_lines.find(
          item=>item.id===row.id
        );

        return (
          <article
            key={row.id}
            className="space-y-2 rounded border border-border p-3"
          >

            <p className="text-sm font-medium">
              {item?.description}
            </p>

            <div className="grid gap-2 sm:grid-cols-3">

              {([
                ["quantity","Quantity"],
                ["unit_price","Unit price"],
                ["tax_amount","Total line tax"],
              ] as const).map(([key,label])=>(
                <label key={key} className="text-xs">

                  {label}

                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={row[key]}
                    onChange={e=>updateLine(
                      row.id,key,e.target.value
                    )}
                    className="mt-1 block w-full rounded border border-input bg-background p-2"
                  />

                </label>
              ))}

            </div>

            <button
              type="button"
              onClick={()=>setLines(current=>
                current.filter(line=>line.id!==row.id)
              )}
              className="text-xs text-destructive"
            >
              Remove line
            </button>

          </article>
        );

      })}

      <div className="rounded border border-border p-3 text-sm">

        <p>
          Prepared amount: {context.currency}{" "}
          {Number.isFinite(total)
            ? total.toFixed(2)
            : "Invalid amount"}
        </p>

        <p>
          Declared amount: {context.currency}{" "}
          {Number(context.declared_amount).toFixed(2)}
        </p>

        <p className={
          matches ? "font-medium" : "text-destructive"
        }>
          {matches
            ? "Prepared amount matches supplier submission."
            : "Prepared amount must match supplier submission."}
        </p>

      </div>

      <p className="text-xs text-muted-foreground">
        Invoice capture creates a draft only. Matching, approval and payment remain separate controlled operations.
      </p>

      <div className="space-y-3 border-t border-border pt-4">

        {context?.execution_enabled !== true && (

          <p className="text-xs text-muted-foreground">

            Invoice capture is awaiting controlled financial activation.
            Reviewing a submission does not create a payable.

          </p>

        )}

        <button

          type="button"

          disabled={
            context?.execution_enabled !== true ||
            !receipt ||
            !matches ||
            lines.length === 0 ||
            capture.isPending ||
            Boolean(capturedInvoice)
          }

          onClick={() => {

            if (
              executionLock.current ||
              capture.isPending ||
              capturedInvoice ||
              context?.execution_enabled !== true
            ) return;

            if (!window.confirm(
              "Capture this verified supplier invoice as an official draft? This does not approve or pay the invoice."
            )) return;

            executionLock.current = true;

            setCaptureMessage("");

            capture.mutate();

          }}

          className="rounded border border-border px-4 py-2 text-sm font-medium disabled:opacity-40"

        >

          {capture.isPending

            ? "Capturing invoice..."

            : capturedInvoice

              ? "Invoice captured"

              : "Capture official supplier invoice"}

        </button>

        {captureMessage && (

          <p role="status" className="text-sm">

            {captureMessage}

          </p>

        )}

      </div>

    </section>
  );
}