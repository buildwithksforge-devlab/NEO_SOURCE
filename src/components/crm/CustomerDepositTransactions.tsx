import { useEffect, useRef, useState } from "react";

import {
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

import {
  validateCustomerDepositAmount,
  validateCustomerDepositAllocation,
  type CustomerAdvanceDeposit,
} from "@/lib/customer-advance-deposits";

const db = supabase as any;

type Account = {
  id:string;
  name:string;
  account_code:string;
};

type Invoice = {
  id:string;
  invoice_number:string;
  currency:string;
  status:string;
  balance:number;
};

type Context = {
  customer_id:string;
  branch_id:string;
  currency:string;
  accounts:Account[];
  invoices:Invoice[];
  deposits:CustomerAdvanceDeposit[];
  collection_enabled:boolean;
  allocation_enabled:boolean;
};

type Attempt = {
  command:string;
  key:string;
  fingerprint:string;
  payload:Record<string,unknown>;
};

export function CustomerDepositTransactions({
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

  const [mode,setMode] =
    useState<"collect" | "allocate">("collect");

  const [amount,setAmount] = useState("");

  const [account,setAccount] = useState("");

  const [deposit,setDeposit] = useState("");

  const [invoice,setInvoice] = useState("");

  const [busy,setBusy] = useState(false);

  const [message,setMessage] = useState("");

  const [unresolved,setUnresolved] =
    useState<Attempt | null>(null);

  const running = useRef(false);

  const storageKey = [
    "neo.customer-deposit-attempt.v1",
    organizationId,
    branchId,
    actorId,
    customerId,
  ].join(":");

  useEffect(()=>{

    try {

      const saved = localStorage.getItem(storageKey);

      if (!saved) {
        setUnresolved(null);
        return;
      }

      const attempt = JSON.parse(saved) as Attempt;

      const allowed = [
        "neo_customer_advance_deposit_record",
        "neo_customer_advance_deposit_allocate",
      ];

      if (
        allowed.includes(attempt.command) &&
        typeof attempt.key === "string" &&
        attempt.payload["_branch"] === branchId &&
        attempt.payload["_customer"] === customerId &&
        attempt.payload["_intent_key"] === attempt.key
      ) {
        setUnresolved(attempt);
      }

    } catch {

      setMessage(
        "Previous transaction recovery could not be verified."
      );
    }

  },[storageKey,branchId,customerId]);

  const query = useQuery({

    queryKey:[
      "customer-deposit-transaction-context",
      organizationId,
      branchId,
      actorId,
      customerId,
    ],

    enabled:Boolean(
      organizationId &&
      branchId &&
      actorId &&
      customerId
    ),

    staleTime:0,

    gcTime:0,

    queryFn:async ():Promise<Context> => {

      const {data,error} = await db.rpc(
        "neo_customer_deposit_transaction_context",
        {
          _branch:branchId,
          _customer:customerId,
        }
      );

      if (error) throw new Error(error.message);

      if (
        data?.customer_id !== customerId ||
        data?.branch_id !== branchId ||
        !Array.isArray(data?.accounts) ||
        !Array.isArray(data?.invoices) ||
        !Array.isArray(data?.deposits) ||
        typeof data.collection_enabled !== "boolean" ||
        typeof data.allocation_enabled !== "boolean"
      ) {
        throw new Error(
          "Customer financial context could not be confirmed."
        );
      }

      return data as Context;
    },
  });

  const context = query.data;

  const selectedDeposit = context?.deposits.find(
    row=>row.id===deposit
  );

  const selectedInvoice = context?.invoices.find(
    row=>row.id===invoice
  );

  const enabled = mode==="collect"
    ? context?.collection_enabled
    : context?.allocation_enabled;

  async function execute(attempt:Attempt) {

    if (running.current) return;

    running.current = true;
    setBusy(true);
    setMessage("");

    try {

      // Persist transaction identity before sending.
      // If storage fails, do not initiate a financial write.
      localStorage.setItem(
        storageKey,
        JSON.stringify(attempt)
      );

      setUnresolved(attempt);

      const {data,error} = await db.rpc(
        attempt.command,
        attempt.payload
      );

      if (error) throw new Error(error.message);

      if (
        data?.ok !== true ||
        !data?.journal_id ||
        (
          attempt.command===
            "neo_customer_advance_deposit_record" &&
          (!data?.deposit_id || !data?.payment_id)
        ) ||
        (
          attempt.command===
            "neo_customer_advance_deposit_allocate" &&
          !data?.movement_id
        )
      ) {
        throw new Error(
          "Transaction outcome requires verification."
        );
      }

      localStorage.removeItem(storageKey);

      setUnresolved(null);

      setAmount("");
      setDeposit("");
      setInvoice("");

      setMessage(
        "Transaction confirmed with accounting evidence."
      );

      await qc.invalidateQueries();

    } catch(error) {

      setMessage(
        error instanceof Error
          ? error.message
          : "Transaction outcome could not be confirmed."
      );

    } finally {

      running.current = false;

      setBusy(false);
    }
  }

  async function verifyPreviousTransaction() {

    if (
      !unresolved ||
      running.current ||
      query.isError
    ) return;

    running.current = true;
    setBusy(true);
    setMessage("");

    try {

      const {data,error} = await db.rpc(
        "neo_customer_deposit_attempt_status",
        {
          _branch:branchId,
          _customer:customerId,
          _command:unresolved.command,
          _intent_key:unresolved.key,
        }
      );

      if (error) throw new Error(error.message);

      if (
        data?.state === "recorded" &&
        data?.journal_id
      ) {

        localStorage.removeItem(storageKey);

        setUnresolved(null);

        setAmount("");
        setDeposit("");
        setInvoice("");

        setMessage(
          "Previous transaction confirmed. No duplicate transaction was created."
        );

        await qc.invalidateQueries();

      } else if (data?.state === "not-recorded") {

        setMessage(
          "No committed transaction was found. Retry using the original transaction identity."
        );

      } else {

        throw new Error(
          "Transaction status could not be verified."
        );

      }

    } catch(error) {

      setMessage(
        error instanceof Error
          ? error.message
          : "Transaction verification failed."
      );

    } finally {

      running.current = false;
      setBusy(false);

    }
  }

  async function submit() {

    if (
      running.current ||
      unresolved ||
      !context ||
      !enabled ||
      query.isError ||
      query.isFetching
    ) return;

    try {

      let command:string;

      let payload:Record<string,unknown>;

      if (mode==="collect") {

        const value =
          validateCustomerDepositAmount(amount);

        if (!context.accounts.some(row=>row.id===account)) {
          throw new Error(
            "Select an authorised receiving account."
          );
        }

        command = "neo_customer_advance_deposit_record";

        payload = {
          _branch:branchId,
          _customer:customerId,
          _amount:value,
          _currency:context.currency,
          _account:account,
        };

      } else {

        if (!selectedDeposit || !selectedInvoice) {
          throw new Error(
            "Select an available deposit and outstanding invoice."
          );
        }

        if (
          selectedDeposit.currency !== selectedInvoice.currency
        ) {
          throw new Error(
            "Deposit and invoice currencies must match."
          );
        }

        const value = validateCustomerDepositAllocation(
          amount,
          Number(selectedDeposit.available_amount),
          Number(selectedInvoice.balance)
        );

        command = "neo_customer_advance_deposit_allocate";

        payload = {
          _branch:branchId,
          _customer:customerId,
          _deposit:deposit,
          _invoice:invoice,
          _amount:value,
        };
      }

      const key = crypto.randomUUID();

      payload["_intent_key"] = key;

      await execute({
        command,
        key,
        fingerprint:JSON.stringify(payload),
        payload,
      });

    } catch(error) {

      setMessage(
        error instanceof Error
          ? error.message
          : "Invalid transaction."
      );
    }
  }

  if (query.isPending) {
    return (
      <p className="text-sm">
        Loading customer transaction controls...
      </p>
    );
  }

  if (query.isError || !context) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Customer transaction context could not be verified.
      </p>
    );
  }

  return (

    <section className="space-y-4 rounded-xl border border-border p-4">

      <h3 className="font-semibold">
        Customer deposit transactions
      </h3>

      <div className="flex flex-wrap gap-2">

        <button
          type="button"
          disabled={busy || Boolean(unresolved)}
          onClick={()=>{
            setMode("collect");
            setAmount("");
          }}
          className="rounded border border-border px-3 py-2 text-sm"
        >
          Receive cash deposit
        </button>

        <button
          type="button"
          disabled={busy || Boolean(unresolved)}
          onClick={()=>{
            setMode("allocate");
            setAmount("");
          }}
          className="rounded border border-border px-3 py-2 text-sm"
        >
          Allocate to invoice
        </button>

      </div>

      <fieldset
        disabled={busy || Boolean(unresolved)}
        className="space-y-3"
      >

        {mode==="collect" ? (

          <label className="block text-sm">

            Receiving cash account

            <select
              value={account}
              onChange={e=>setAccount(e.target.value)}
              className="mt-1 block w-full rounded border border-input bg-background p-2"
            >

              <option value="">
                Select account
              </option>

              {context.accounts.map(row=>(
                <option key={row.id} value={row.id}>
                  {row.name} — {row.account_code}
                </option>
              ))}

            </select>

          </label>

        ) : (

          <>

            <label className="block text-sm">

              Available customer deposit

              <select
                value={deposit}
                onChange={e=>setDeposit(e.target.value)}
                className="mt-1 block w-full rounded border border-input bg-background p-2"
              >

                <option value="">Select deposit</option>

                {context.deposits.filter(
                  row=>Number(row.available_amount)>0
                ).map(row=>(
                  <option key={row.id} value={row.id}>
                    {row.receipt_number} — {row.currency}
                    {" "}
                    {Number(row.available_amount).toFixed(2)}
                  </option>
                ))}

              </select>

            </label>

            <label className="block text-sm">

              Outstanding customer invoice

              <select
                value={invoice}
                onChange={e=>setInvoice(e.target.value)}
                className="mt-1 block w-full rounded border border-input bg-background p-2"
              >

                <option value="">Select invoice</option>

                {context.invoices.map(row=>(
                  <option key={row.id} value={row.id}>
                    {row.invoice_number} — {row.currency}
                    {" "}
                    {Number(row.balance).toFixed(2)}
                  </option>
                ))}

              </select>

            </label>

          </>

        )}

        <label className="block text-sm">

          Amount ({context.currency})

          <input
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={e=>setAmount(e.target.value)}
            className="mt-1 block w-full rounded border border-input bg-background p-2"
          />

        </label>

      </fieldset>

      {!enabled && (

        <p className="text-sm text-muted-foreground">
          Financial execution is not enabled.
          Awaiting authorised release activation.
        </p>

      )}

      <button
        type="button"
        disabled={
          !enabled ||
          busy ||
          Boolean(unresolved) ||
          !amount.trim() ||
          query.isFetching
        }
        onClick={()=>void submit()}
        className="rounded border border-border px-4 py-2 text-sm font-medium disabled:opacity-40"
      >
        {busy
          ? "Processing..."
          : mode==="collect"
            ? "Confirm cash deposit"
            : "Confirm deposit allocation"}
      </button>

      {unresolved && (

        <div className="space-y-2 rounded border border-border p-3">

          <p className="text-sm font-medium">
            Previous transaction requires confirmation.
          </p>

          <p className="text-xs text-muted-foreground">
            Retry the same transaction identity.
            Do not enter a replacement transaction.
          </p>

          <button
            type="button"
            disabled={
              busy ||
              (
                unresolved.command===
                  "neo_customer_advance_deposit_record"
                ? !context.collection_enabled
                : !context.allocation_enabled
              )
            }
            onClick={()=>void execute(unresolved)}
            className="rounded border border-border px-3 py-2 text-sm"
          >
            Recover previous transaction
          </button>

          <button
            type="button"
            disabled={busy || query.isFetching}
            onClick={()=>void verifyPreviousTransaction()}
            className="ml-2 rounded border border-border px-3 py-2 text-sm"
          >
            Verify previous transaction
          </button>

        </div>

      )}

      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Advance deposits remain customer liabilities until
        allocated or refunded. Allocation does not create
        another cash receipt.
      </p>

    </section>
  );
}