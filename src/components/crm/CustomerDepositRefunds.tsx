import { useEffect, useRef, useState } from "react";

import {
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

const db = supabase as any;

type Refund = {
  id:string;
  deposit_id:string;
  amount:number;
  currency:string;
  reason:string;
  status:string;
  requested_at:string;
  decision_note?:string;
  may_decide:boolean;
  refund_payment_id?:string;
};

type Deposit = {
  id:string;
  receipt_number:string;
  currency:string;
  unspent_amount:number;
  reserved_amount:number;
};

type RefundContext = {
  customer_id:string;
  branch_id:string;
  history:Refund[];
  deposits:Deposit[];
  accounts:{id:string;name:string}[];
  request_enabled:boolean;
  decision_enabled:boolean;
  settlement_enabled:boolean;
};

type Attempt = {
  command:string;
  payload:Record<string,unknown>;
};

export function CustomerDepositRefunds({
  customerId,
  branchId,
  organizationId,
  actorId,
}:{
  customerId:string;
  branchId:string;
  organizationId:string;
  actorId:string;
}) {

  const qc = useQueryClient();

  const running = useRef(false);

  const [expanded,setExpanded] = useState(false);
  const [busy,setBusy] = useState(false);
  const [depositId,setDepositId] = useState("");
  const [amount,setAmount] = useState("");
  const [reason,setReason] = useState("");
  const [selected,setSelected] = useState("");
  const [note,setNote] = useState("");
  const [account,setAccount] = useState("");
  const [message,setMessage] = useState("");

  const [attempt,setAttempt] =
    useState<Attempt | null>(null);

  const [recoveryReady,setRecoveryReady] =
    useState(false);

  const storageKey = [
    "neo.deposit-refund-attempt.v1",
    organizationId,
    branchId,
    actorId,
    customerId,
  ].join(":");

  useEffect(()=>{

    setRecoveryReady(false);

    try {

      const saved = localStorage.getItem(storageKey);

      if (!saved) {
        setAttempt(null);
        setRecoveryReady(true);
        return;
      }

      const parsed = JSON.parse(saved) as Attempt;

      if (
        ![
          "neo_customer_deposit_refund_request",
          "neo_customer_deposit_refund_decide",
          "neo_customer_deposit_refund_settle",
        ].includes(parsed.command) ||
        !parsed.payload ||
        typeof parsed.payload !== "object"
      ) {
        throw new Error("Invalid saved transaction.");
      }

      setAttempt(parsed);
      setRecoveryReady(true);

    } catch {

      setMessage(
        "Refund recovery storage requires reconciliation."
      );
    }

  },[storageKey]);

  const query = useQuery({

    queryKey:[
      "customer-deposit-refunds",
      organizationId,
      branchId,
      actorId,
      customerId,
    ],

    enabled:expanded,

    gcTime:0,

    staleTime:0,

    queryFn:async ():Promise<RefundContext> => {

      const {data,error} = await db.rpc(
        "neo_customer_deposit_refund_context",
        {
          _branch:branchId,
          _customer:customerId,
        }
      );

      if (error) throw new Error(error.message);

      if (
        data?.customer_id !== customerId ||
        data?.branch_id !== branchId ||
        !Array.isArray(data?.history) ||
        !Array.isArray(data?.deposits) ||
        !Array.isArray(data?.accounts) ||
        typeof data.request_enabled !== "boolean" ||
        typeof data.decision_enabled !== "boolean" ||
        typeof data.settlement_enabled !== "boolean"
      ) {
        throw new Error(
          "Refund context could not be verified."
        );
      }

      for (const row of data.deposits) {

        const unspent = Number(row.unspent_amount);
        const reserved = Number(row.reserved_amount);

        if (
          row.unspent_amount == null ||
          row.reserved_amount == null ||
          !Number.isFinite(unspent) ||
          !Number.isFinite(reserved) ||
          reserved < 0 ||
          unspent < reserved
        ) {
          throw new Error(
            "Deposit reservations require reconciliation."
          );
        }
      }

      return data as RefundContext;
    },
  });

  const context = query.data;

  const deposit = context?.deposits.find(
    row=>row.id===depositId
  );

  const selectedRefund = context?.history.find(
    row=>row.id===selected
  );

  const available = deposit
    ? Number(deposit.unspent_amount) -
      Number(deposit.reserved_amount)
    : 0;

  function commandEnabled(command:string) {

    if (
      !context ||
      query.isError ||
      query.isFetching
    ) return false;

    switch(command) {

      case "neo_customer_deposit_refund_request":
        return context.request_enabled;

      case "neo_customer_deposit_refund_decide":
        return context.decision_enabled;

      case "neo_customer_deposit_refund_settle":
        return context.settlement_enabled;

      default:
        return false;
    }
  }

  async function execute(next:Attempt) {

    if (
      running.current ||
      !recoveryReady ||
      !commandEnabled(next.command)
    ) return;

    running.current = true;
    setBusy(true);
    setMessage("");

    try {

      localStorage.setItem(
        storageKey,
        JSON.stringify(next)
      );

      setAttempt(next);

      const {data,error} = await db.rpc(
        next.command,
        next.payload
      );

      if (error) throw new Error(error.message);

      if (
        data?.ok !== true ||
        !data?.refund_id
      ) {
        throw new Error(
          "Refund transaction could not be confirmed."
        );
      }

      if (
        next.command !==
          "neo_customer_deposit_refund_request" &&
        data.refund_id !== next.payload["_refund"]
      ) {
        throw new Error(
          "Refund transaction identity mismatch."
        );
      }

      if (
        next.command===
          "neo_customer_deposit_refund_settle" &&
        (
          data.status !== "settled" ||
          !data.payment_id ||
          !data.journal_id
        )
      ) {
        throw new Error(
          "Refund settlement evidence is incomplete."
        );
      }

      localStorage.removeItem(storageKey);

      setAttempt(null);
      setAmount("");
      setReason("");
      setSelected("");
      setNote("");
      setAccount("");

      setMessage(
        `Refund status confirmed: ${data.status}.`
      );

      await qc.invalidateQueries();

    } catch(error) {

      setMessage(
        error instanceof Error
          ? error.message
          : "Refund transaction requires verification."
      );

    } finally {

      running.current = false;
      setBusy(false);

    }
  }

  function requestRefund() {

    const value = Number(amount);

    if (
      attempt ||
      !deposit ||
      !amount.trim() ||
      !Number.isFinite(value) ||
      value<=0 ||
      Math.abs(
        value*100-Math.round(value*100)
      )>0.000001 ||
      value>available ||
      reason.trim().length<10
    ) {

      setMessage(
        "Select a deposit, valid available amount and refund reason."
      );

      return;
    }

    void execute({

      command:"neo_customer_deposit_refund_request",

      payload:{

        _branch:branchId,
        _customer:customerId,
        _deposit:deposit.id,
        _amount:value,
        _reason:reason.trim(),
        _intent_key:crypto.randomUUID(),

      },
    });
  }

  function decide(approve:boolean) {

    if (
      attempt ||
      !selectedRefund?.may_decide ||
      selectedRefund.status!=="pending-approval" ||
      note.trim().length<10
    ) return;

    void execute({

      command:"neo_customer_deposit_refund_decide",

      payload:{

        _refund:selectedRefund.id,
        _approve:approve,
        _note:note.trim(),

      },
    });
  }

  function settle() {

    if (
      attempt ||
      selectedRefund?.status!=="approved" ||
      !context?.accounts.some(
        row=>row.id===account
      )
    ) return;

    if (!window.confirm(
      "Confirm the approved cash refund is ready for disbursement. Do not pay the customer twice."
    )) return;

    void execute({

      command:"neo_customer_deposit_refund_settle",

      payload:{

        _refund:selectedRefund.id,
        _account:account,

      },
    });
  }

  const locked =
    busy ||
    Boolean(attempt) ||
    !recoveryReady ||
    query.isFetching;

  return (

    <section className="space-y-3 rounded-xl border border-border p-4">

      <button
        type="button"
        onClick={()=>setExpanded(value=>!value)}
        className="font-semibold"
      >
        {expanded
          ? "Hide customer deposit refunds"
          : "Customer deposit refunds"}
      </button>

      {expanded && (

        <>

          {query.isPending && (
            <p className="text-sm">
              Loading refund controls...
            </p>
          )}

          {query.isError && (
            <p role="alert" className="text-sm text-destructive">
              Refund context requires verification.
            </p>
          )}

          {query.isSuccess && context && (

            <>

              <fieldset
                disabled={
                  locked ||
                  !context.request_enabled
                }
                className="space-y-3"
              >

                <h4 className="text-sm font-medium">
                  Request refund
                </h4>

                <select
                  value={depositId}
                  onChange={e=>setDepositId(e.target.value)}
                  className="w-full rounded border border-input bg-background p-2"
                >
                  <option value="">Select deposit</option>

                  {context.deposits.map(row=>(
                    <option key={row.id} value={row.id}>
                      {row.receipt_number}
                      {" — "}
                      {row.currency}
                      {" "}
                      {(
                        Number(row.unspent_amount)-
                        Number(row.reserved_amount)
                      ).toFixed(2)}
                    </option>
                  ))}
                </select>

                {deposit && (
                  <p className="text-xs text-muted-foreground">
                    Reserved refunds: {deposit.currency}
                    {" "}
                    {Number(deposit.reserved_amount).toFixed(2)}
                  </p>
                )}

                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={amount}
                  placeholder="Refund amount"
                  onChange={e=>setAmount(e.target.value)}
                  className="w-full rounded border border-input bg-background p-2"
                />

                <textarea
                  rows={3}
                  maxLength={4000}
                  value={reason}
                  placeholder="Refund reason"
                  onChange={e=>setReason(e.target.value)}
                  className="w-full rounded border border-input bg-background p-2"
                />

                <button
                  type="button"
                  onClick={requestRefund}
                  className="rounded border border-border px-4 py-2 text-sm"
                >
                  Submit refund request
                </button>

              </fieldset>

              {!context.request_enabled && (
                <p className="text-xs text-muted-foreground">
                  Refund requests are unavailable for this role
                  or have not been activated.
                </p>
              )}

              <h4 className="text-sm font-semibold">
                Refund request history
              </h4>

              {!context.history.length && (
                <p className="text-sm text-muted-foreground">
                  No refund requests recorded.
                </p>
              )}

              {context.history.map(row=>(
                <article
                  key={row.id}
                  className="space-y-2 rounded border border-border p-3 text-sm"
                >

                  <div className="flex justify-between gap-2">

                    <span>
                      {row.currency}{" "}
                      {Number(row.amount).toFixed(2)}
                    </span>

                    <span className="font-medium">
                      {row.status}
                    </span>

                  </div>

                  <p>{row.reason}</p>

                  {row.decision_note && (
                    <p className="text-xs text-muted-foreground">
                      Decision: {row.decision_note}
                    </p>
                  )}

                  {row.status==="settled" && (
                    <p className="text-xs">
                      Refund payment recorded.
                    </p>
                  )}

                  {(
                    (
                      row.may_decide &&
                      context.decision_enabled
                    ) ||
                    (
                      row.status==="approved" &&
                      context.settlement_enabled
                    )
                  ) && (

                    <button
                      type="button"
                      disabled={locked}
                      onClick={()=>{
                        setSelected(row.id);
                        setNote("");
                        setAccount("");
                      }}
                      className="rounded border border-border px-3 py-1 text-xs"
                    >
                      {row.status==="approved"
                        ? "Settle approved refund"
                        : "Review refund"}
                    </button>

                  )}

                </article>
              ))}

              {selectedRefund && (

                <fieldset
                  disabled={locked}
                  className="space-y-3 rounded border border-border p-3"
                >

                  {selectedRefund.status==="pending-approval" &&

                    selectedRefund.may_decide && (

                    <>

                      <textarea
                        rows={3}
                        maxLength={4000}
                        value={note}
                        placeholder="Approval or rejection reason"
                        onChange={e=>setNote(e.target.value)}
                        className="w-full rounded border border-input bg-background p-2"
                      />

                      <div className="flex gap-2">

                        <button
                          type="button"
                          disabled={
                            !context.decision_enabled ||
                            note.trim().length<10
                          }
                          onClick={()=>decide(true)}
                          className="rounded border border-border px-3 py-2 text-sm"
                        >
                          Approve
                        </button>

                        <button
                          type="button"
                          disabled={
                            !context.decision_enabled ||
                            note.trim().length<10
                          }
                          onClick={()=>decide(false)}
                          className="rounded border border-border px-3 py-2 text-sm"
                        >
                          Reject
                        </button>

                      </div>

                    </>
                  )}

                  {selectedRefund.status==="approved" && (

                    <>

                      <p className="text-sm font-medium">
                        Cash refund: {selectedRefund.currency}
                        {" "}
                        {Number(selectedRefund.amount).toFixed(2)}
                      </p>

                      <select
                        value={account}
                        onChange={e=>setAccount(e.target.value)}
                        className="w-full rounded border border-input bg-background p-2"
                      >

                        <option value="">
                          Select cash settlement account
                        </option>

                        {context.accounts.map(row=>(
                          <option key={row.id} value={row.id}>
                            {row.name}
                          </option>
                        ))}

                      </select>

                      <button
                        type="button"
                        disabled={
                          !context.settlement_enabled ||
                          !account
                        }
                        onClick={settle}
                        className="rounded border border-border px-4 py-2 text-sm"
                      >
                        Record cash refund settlement
                      </button>

                    </>
                  )}

                </fieldset>

              )}

              {attempt && (

                <div className="space-y-2 rounded border border-border p-3">

                  <p className="text-sm font-medium">
                    Previous refund transaction requires confirmation.
                  </p>

                  <button
                    type="button"
                    disabled={
                      busy ||
                      !commandEnabled(attempt.command)
                    }
                    onClick={()=>void execute(attempt)}
                    className="rounded border border-border px-3 py-2 text-sm"
                  >
                    Recover same refund transaction
                  </button>

                </div>

              )}

            </>
          )}

          {message && (
            <p role="status" className="text-sm">
              {message}
            </p>
          )}

        </>

      )}

    </section>
  );
}