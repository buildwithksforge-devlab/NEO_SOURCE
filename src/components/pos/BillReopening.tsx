import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import {
  reopeningRequestPayload,
  reopeningDecisionPayload,
  reopeningExecutionPayload,
  validateReopeningResponse,
} from "@/lib/bill-reopening";

const db=supabase as any;

type HistoryRow={
  id:string;
  reason:string;
  status:string;
  requested_at:string;
  decision_note?:string;
  may_decide:boolean;
};

type Context={
  order_id:string;
  financial_evidence:{
    order_status:string;
    payment_status:string;
    payment_record_count:number;
    pending_refund_count:number;
    invalid_refund_count:number;
  };
  request_enabled:boolean;
  approval_enabled:boolean;
  execution_enabled:boolean;
  execution_financially_eligible:boolean;
  requires_financial_reconciliation:boolean;
  history:HistoryRow[];
};

type Attempt={
  command:string;
  payload:Record<string,unknown>;
};

export function BillReopening({
  orderId,
}:{
  orderId:string;
}) {

  const {organizationId,user}=useAuth();

  const qc=useQueryClient();

  const running=useRef(false);

  const [expanded,setExpanded]=useState(false);
  const [reason,setReason]=useState("");
  const [note,setNote]=useState("");
  const [selected,setSelected]=useState("");
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  const [attempt,setAttempt]=useState<Attempt|null>(null);
  const [ready,setReady]=useState(false);

  const storageKey=[
    "neo.bill-reopening.v1",
    organizationId,
    user?.id,
    orderId,
  ].join(":");

  useEffect(()=>{

    setReady(false);

    try {

      const saved=localStorage.getItem(storageKey);

      if (!saved) {

        setAttempt(null);
        setReady(true);
        return;
      }

      const parsed=JSON.parse(saved) as Attempt;

      if (
        ![
          "neo_pos_request_bill_reopening",
          "neo_pos_decide_bill_reopening",
          "neo_pos_execute_bill_reopening",
        ].includes(parsed.command) ||
        !parsed.payload ||
        typeof parsed.payload!=="object"
      ) {
        throw new Error("Invalid recovery record.");
      }

      setAttempt(parsed);
      setReady(true);

    } catch {

      setMessage(
        "Previous reopening transaction requires reconciliation."
      );
    }

  },[storageKey]);

  const query=useQuery({

    queryKey:[
      "pos-bill-reopening",
      organizationId,
      user?.id,
      orderId,
    ],

    enabled:expanded &&
      Boolean(organizationId && user?.id),

    staleTime:0,

    gcTime:0,

    queryFn:async():Promise<Context>=>{

      const {data,error}=await db.rpc(
        "neo_pos_bill_reopening_execution_context",
        {_order:orderId}
      );

      if(error) throw new Error(error.message);

      if(
        data?.order_id!==orderId ||
        !data.financial_evidence ||
        !Array.isArray(data.history) ||
        typeof data.request_enabled!=="boolean" ||
        typeof data.approval_enabled!=="boolean" ||
        typeof data.execution_enabled!=="boolean" ||
        typeof data.execution_financially_eligible!=="boolean"
      ) {
        throw new Error(
          "Bill reopening context could not be verified."
        );
      }

      return data as Context;
    },
  });

  const context=query.data;

  const active=context?.history.find(
    row=>[
      "pending-approval",
      "approved",
    ].includes(row.status)
  );

  const selectedRow=context?.history.find(
    row=>row.id===selected
  );

  const finished=[
    "closed",
    "completed",
    "paid",
  ].includes(
    context?.financial_evidence.order_status??""
  );

  function allowed(command:string) {

    if(
      !context ||
      query.isError ||
      query.isFetching
    ) return false;

    switch(command) {

      case "neo_pos_request_bill_reopening":
        return context.request_enabled;

      case "neo_pos_decide_bill_reopening":
        return context.approval_enabled;

      case "neo_pos_execute_bill_reopening":
        return context.execution_enabled;

      default:
        return false;
    }
  }

  async function execute(next:Attempt) {

    if(
      running.current ||
      !ready ||
      !allowed(next.command)
    ) return;

    running.current=true;
    setBusy(true);
    setMessage("");

    try {

      localStorage.setItem(
        storageKey,
        JSON.stringify(next)
      );

      setAttempt(next);

      const {data,error}=await db.rpc(
        next.command,
        next.payload
      );

      if(error) throw new Error(error.message);

      const execution=
        next.command==="neo_pos_execute_bill_reopening";

      const result=validateReopeningResponse(
        data,
        orderId,
        typeof next.payload["_request"]==="string"
          ? next.payload["_request"]
          : undefined,
        execution
      );

      localStorage.removeItem(storageKey);

      setAttempt(null);
      setReason("");
      setNote("");
      setSelected("");

      setMessage(
        execution
          ? "Bill reopening confirmed. Reloaded order data is required before making changes."
          : `Reopening status confirmed: ${result.status}.`
      );

      await qc.invalidateQueries();

    } catch(error) {

      setMessage(
        error instanceof Error
          ? error.message
          : "Bill reopening requires verification."
      );

    } finally {

      running.current=false;
      setBusy(false);
    }
  }

  function request() {

    if(attempt || active || !finished) return;

    try {

      void execute({

        command:"neo_pos_request_bill_reopening",

        payload:reopeningRequestPayload(
          orderId,
          reason,
          crypto.randomUUID()
        ),
      });

    } catch(error) {

      setMessage(String(error));
    }
  }

  function decide(approve:boolean) {

    if(
      attempt ||
      !selectedRow?.may_decide
    ) return;

    try {

      void execute({

        command:"neo_pos_decide_bill_reopening",

        payload:reopeningDecisionPayload(
          selectedRow.id,
          approve,
          note
        ),
      });

    } catch(error) {

      setMessage(String(error));
    }
  }

  function reopen(row:HistoryRow) {

    if(
      attempt ||
      row.status!=="approved" ||
      !context?.execution_financially_eligible ||
      !finished
    ) return;

    if(!window.confirm(
      "Reopen this approved unpaid bill? Existing production items must remain unchanged."
    )) return;

    void execute({

      command:"neo_pos_execute_bill_reopening",

      payload:reopeningExecutionPayload(
        row.id
      ),
    });
  }

  const locked=
    busy ||
    Boolean(attempt) ||
    !ready ||
    query.isFetching;

  return (

    <section className="space-y-3 rounded-xl border border-border p-4">

      <button
        type="button"
        onClick={()=>setExpanded(value=>!value)}
        className="text-sm font-semibold"
      >
        {expanded
          ? "Hide bill reopening controls"
          : "Controlled bill reopening"}
      </button>

      {expanded && (

        <>

          {query.isPending && (
            <p className="text-sm">
              Loading bill reopening controls...
            </p>
          )}

          {query.isError && (
            <p role="alert" className="text-sm text-destructive">
              Reopening information is unavailable for this session.
            </p>
          )}

          {query.isSuccess && context && (

            <>

              <div className="space-y-1 rounded border border-border p-3 text-sm">

                <p>
                  Order status: {context.financial_evidence.order_status}
                </p>

                <p>
                  Payment status: {context.financial_evidence.payment_status}
                </p>

                <p>
                  Existing payment records: {context.financial_evidence.payment_record_count}
                </p>

                <p>
                  Pending refunds: {context.financial_evidence.pending_refund_count}
                </p>

              </div>

              {context.requires_financial_reconciliation && (

                <p role="alert" className="rounded border border-border p-3 text-sm">

                  Financial reconciliation is required.
                  This bill cannot be directly reopened.

                </p>

              )}

              {finished && !active && (

                <fieldset
                  disabled={
                    locked ||
                    !context.request_enabled
                  }
                  className="space-y-2"
                >

                  <textarea
                    value={reason}
                    onChange={e=>setReason(e.target.value)}
                    placeholder="Reason for reopening this bill"
                    maxLength={4000}
                    rows={3}
                    className="w-full rounded border border-input bg-background p-2"
                  />

                  <button
                    type="button"
                    onClick={request}
                    disabled={reason.trim().length<10}
                    className="rounded border border-border px-3 py-2 text-sm"
                  >
                    Request bill reopening
                  </button>

                </fieldset>

              )}

              {context.history.map(row=>(

                <article
                  key={row.id}
                  className="space-y-2 rounded border border-border p-3 text-sm"
                >

                  <p className="font-medium">
                    {row.status}
                  </p>

                  <p>{row.reason}</p>

                  {row.decision_note && (
                    <p className="text-xs">
                      Decision: {row.decision_note}
                    </p>
                  )}

                  {row.may_decide && context.approval_enabled && (

                    <button
                      type="button"
                      disabled={locked}
                      onClick={()=>{
                        setSelected(row.id);
                        setNote("");
                      }}
                      className="rounded border border-border px-3 py-2"
                    >
                      Review reopening request
                    </button>

                  )}

                  {row.status==="approved" && (

                    <button
                      type="button"
                      disabled={
                        locked ||
                        !finished ||
                        !context.execution_enabled ||
                        !context.execution_financially_eligible
                      }
                      onClick={()=>reopen(row)}
                      className="rounded border border-border px-3 py-2 disabled:opacity-40"
                    >
                      Execute approved reopening
                    </button>

                  )}

                </article>
              ))}

              {selectedRow?.may_decide && (

                <fieldset
                  disabled={locked}
                  className="space-y-2"
                >

                  <textarea
                    value={note}
                    onChange={e=>setNote(e.target.value)}
                    placeholder="Approval or rejection reason"
                    maxLength={4000}
                    rows={3}
                    className="w-full rounded border border-input bg-background p-2"
                  />

                  <div className="flex gap-2">

                    <button
                      type="button"
                      disabled={note.trim().length<10}
                      onClick={()=>decide(true)}
                      className="rounded border border-border px-3 py-2 text-sm"
                    >
                      Approve
                    </button>

                    <button
                      type="button"
                      disabled={note.trim().length<10}
                      onClick={()=>decide(false)}
                      className="rounded border border-border px-3 py-2 text-sm"
                    >
                      Reject
                    </button>

                  </div>

                </fieldset>

              )}

              {attempt && (

                <div className="space-y-2 rounded border border-border p-3">

                  <p className="text-sm">
                    Previous reopening command requires confirmation.
                  </p>

                  <button
                    type="button"
                    disabled={busy || !allowed(attempt.command)}
                    onClick={()=>void execute(attempt)}
                    className="rounded border border-border px-3 py-2 text-sm"
                  >
                    Recover same reopening transaction
                  </button>

                </div>

              )}

              {!context.execution_enabled && (

                <p className="text-xs text-muted-foreground">

                  Reopening execution has not been activated
                  or is unavailable for this role.

                </p>

              )}

            </>
          )}

          {message && (
            <p role="status" className="text-sm">
              {message}
            </p>
          )}

          <p className="text-xs text-muted-foreground">

            Reopening must preserve existing production,
            stock and financial history.

          </p>

        </>

      )}

    </section>
  );
}