import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  executeApprovedComplimentary,
} from "@/lib/complimentary-pos-execution";
import { useAuth } from "@/lib/auth";

const db = supabase as any;

type Eligible = {
  order_item_id:string;
  item_name:string;
  quantity:number;
  unit_price:number;
  approved_value:number;
  approval_id:string;
  reason:string;
  approved_at:string;
  beneficiary_name?:string;
};

type Executed = {
  order_item_id:string;
  approval_id:string;
  item_name:string;
  quantity:number;
  executed_at:string;
  status:string;
};

type Context = {
  order_id:string;
  enabled:boolean;
  eligible:Eligible[];
  executed:Executed[];
};

export function ComplimentaryExecution({
  orderId,
}:{
  orderId:string;
}) {

  const {
    organizationId,
    user,
  } = useAuth();

  const qc = useQueryClient();

  const running = useRef(false);

  const [expanded,setExpanded] = useState(false);

  const [selected,setSelected] = useState("");

  const [busy,setBusy] = useState(false);

  const [message,setMessage] = useState("");

  const [recovery,setRecovery] =
    useState<Eligible | null>(null);

  const query = useQuery({

    queryKey:[
      "pos-complimentary-context",
      organizationId,
      user?.id,
      orderId,
    ],

    enabled:expanded && Boolean(
      organizationId && user?.id && orderId
    ),

    gcTime:0,

    staleTime:0,

    queryFn:async ():Promise<Context> => {

      const {data,error} = await db.rpc(
        "neo_pos_complimentary_context",
        {_order:orderId}
      );

      if (error) throw new Error(error.message);

      if (
        data?.order_id !== orderId ||
        typeof data.enabled !== "boolean" ||
        !Array.isArray(data.eligible) ||
        !Array.isArray(data.executed)
      ) {
        throw new Error(
          "Complimentary context could not be verified."
        );
      }

      return data as Context;
    },
  });

  const context = query.data;

  const keyFor = (row:Eligible) =>
    `${row.order_item_id}:${row.approval_id}`;

  const choice = context?.eligible.find(
    row=>keyFor(row)===selected
  );

  async function apply(row:Eligible) {

    if (
      running.current ||
      context?.enabled !== true ||
      query.isFetching ||
      query.isError
    ) return;

    if (
      recovery &&
      keyFor(recovery)!==keyFor(row)
    ) return;

    if (!recovery && !window.confirm(
      `Apply approved complimentary to ${row.quantity} × ${row.item_name}?`
    )) return;

    running.current = true;

    setBusy(true);

    setMessage("");

    setRecovery(row);

    try {

      await executeApprovedComplimentary(
        orderId,
        row.order_item_id,
        row.approval_id
      );

      setRecovery(null);

      setSelected("");

      setMessage(
        "Complimentary application confirmed."
      );

      await qc.invalidateQueries();

    } catch(error) {

      setMessage(
        error instanceof Error
          ? error.message
          : "Execution requires verification."
      );

    } finally {

      running.current = false;

      setBusy(false);
    }
  }

  async function verifyRecovery() {

    if (!recovery || busy) return;

    setBusy(true);

    try {

      const result = await query.refetch();

      if (result.isError) {
        throw new Error(
          "Execution evidence could not be retrieved."
        );
      }

      const confirmed =
        result.data?.executed.some(row=>
          row.approval_id===recovery.approval_id &&
          row.order_item_id===recovery.order_item_id
        );

      if (confirmed) {

        setRecovery(null);

        setSelected("");

        setMessage(
          "Existing complimentary execution confirmed."
        );

        await qc.invalidateQueries();

      } else {

        setMessage(
          "Execution not yet confirmed. Retry the same approval and item only."
        );
      }

    } catch(error) {

      setMessage(
        error instanceof Error
          ? error.message
          : "Verification failed."
      );

    } finally {

      setBusy(false);
    }
  }

  return (

    <section className="space-y-3 rounded-xl border border-border p-3">

      <button
        type="button"
        className="text-sm font-semibold"
        onClick={()=>setExpanded(value=>!value)}
      >
        {expanded
          ? "Hide complimentary approvals"
          : "Apply approved complimentary"}
      </button>

      {expanded && (

        <>

          {query.isPending && (
            <p className="text-sm">
              Loading eligible approvals...
            </p>
          )}

          {query.isError && (
            <p role="alert" className="text-sm text-destructive">
              Complimentary approvals are unavailable
              for this session or order.
            </p>
          )}

          {query.isSuccess && context && (

            <>

              {!context.enabled && (
                <p className="text-xs text-muted-foreground">
                  Complimentary execution has not been activated.
                </p>
              )}

              {context.eligible.length===0 && (
                <p className="text-sm text-muted-foreground">
                  No matching unused approvals for unpaid draft items.
                </p>
              )}

              {context.eligible.length>0 && (

                <fieldset
                  disabled={
                    busy ||
                    Boolean(recovery) ||
                    !context.enabled ||
                    query.isFetching
                  }
                  className="space-y-2"
                >

                  <select
                    value={selected}
                    onChange={e=>setSelected(e.target.value)}
                    className="w-full rounded border border-input bg-background p-2 text-sm"
                  >

                    <option value="">
                      Select item and approved complimentary
                    </option>

                    {context.eligible.map(row=>(
                      <option
                        key={keyFor(row)}
                        value={keyFor(row)}
                      >
                        {row.quantity} × {row.item_name}
                        {" — "}
                        {row.beneficiary_name || "Approved beneficiary"}
                        {" — "}
                        {row.reason}
                      </option>
                    ))}

                  </select>

                  {choice && (

                    <div className="space-y-1 rounded border border-border p-2 text-xs">

                      <p>
                        Approved normal value:
                        {" "}
                        {Number(choice.approved_value).toFixed(2)}
                      </p>

                      <p>Customer item charge: 0.00</p>

                      <p>Reason: {choice.reason}</p>

                    </div>

                  )}

                  <button
                    type="button"
                    disabled={!choice}
                    onClick={()=>{
                      if(choice) void apply(choice);
                    }}
                    className="rounded border border-border px-3 py-2 text-sm disabled:opacity-40"
                  >
                    Apply complimentary
                  </button>

                </fieldset>

              )}

              {recovery && (

                <div className="space-y-2 rounded border border-border p-3 text-sm">

                  <p>
                    Previous execution requires confirmation.
                  </p>

                  <button
                    type="button"
                    disabled={busy}
                    onClick={()=>void verifyRecovery()}
                    className="rounded border border-border px-3 py-2"
                  >
                    Verify existing execution
                  </button>

                  <button
                    type="button"
                    disabled={
                      busy ||
                      !context.enabled ||
                      query.isFetching
                    }
                    onClick={()=>void apply(recovery)}
                    className="rounded border border-border px-3 py-2"
                  >
                    Retry same approval
                  </button>

                </div>

              )}

              {context.executed.map(row=>(
                <div
                  key={row.approval_id}
                  className="rounded border border-border p-2 text-xs"
                >
                  {row.quantity} × {row.item_name}
                  {" — Complimentary applied — "}
                  {row.status}
                </div>
              ))}

            </>
          )}

          {message && (
            <p role="status" className="text-sm">
              {message}
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            Complimentary approval changes the item charge,
            not its production or stock requirements.
          </p>

        </>

      )}

    </section>
  );
}