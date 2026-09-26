/**
 * The write and read path for canonical transaction state.
 *
 * Modules do not set a status directly. They declare a transition here; the
 * shared state machine (`canonical-workflow.ts`) decides whether it is legal,
 * and `neo_canonical_transaction_set` persists it together with a history row,
 * the property and organisation that own it, the actor, the idempotency key,
 * the downstream handoff references and the next action.
 *
 * Every dashboard, register and module page that needs "what state is this in"
 * reads the projection below rather than deriving it from its own table, which
 * is what keeps Finance, PMS, Stores, KDS, Events and room operations telling
 * the same story about the same record.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import {
  type CanonicalFacts,
  type EntityKind,
  assertTransition,
  missingCanonicalFacts,
  normaliseState,
  nextActionFor,
  ownerFor,
  workflowFor,
} from "@/lib/canonical-workflow";

/* eslint-disable @typescript-eslint/no-explicit-any */
const rpc = (fn: string, args: Record<string, unknown>) =>
  (supabase as any).rpc(fn, args) as Promise<{ data: any; error: { message: string } | null }>;

export type CanonicalStateRow = {
  id: string;
  organizationId: string;
  branchId: string | null;
  module: string;
  sourceId: string;
  reference: string | null;
  operationalState: string;
  financialState: string;
  amount: number;
  currency: string;
  idempotencyKey: string | null;
  actorId: string | null;
  owner: string | null;
  nextAction: string | null;
  blocker: string | null;
  journalId: string | null;
  receiptId: string | null;
  downstream: Record<string, unknown>;
  metadata: Record<string, unknown>;
  version: number;
  occurredAt: string | null;
  updatedAt: string | null;
};

function mapRow(r: Record<string, unknown>): CanonicalStateRow {
  return {
    id: String(r["id"] ?? ""),
    organizationId: String(r["organization_id"] ?? ""),
    branchId: (r["branch_id"] as string) ?? null,
    module: String(r["source_module"] ?? ""),
    sourceId: String(r["source_id"] ?? ""),
    reference: (r["source_reference"] as string) ?? null,
    operationalState: String(r["operational_state"] ?? "pending"),
    financialState: String(r["financial_state"] ?? "pending"),
    amount: Number(r["amount"] ?? 0),
    currency: String(r["currency"] ?? "KES"),
    idempotencyKey: (r["idempotency_key"] as string) ?? null,
    actorId: (r["actor_id"] as string) ?? null,
    owner: (r["current_owner"] as string) ?? null,
    nextAction: (r["next_action"] as string) ?? null,
    blocker: (r["blocking_reason"] as string) ?? null,
    journalId: (r["journal_id"] as string) ?? null,
    receiptId: (r["receipt_id"] as string) ?? null,
    downstream: (r["downstream_references"] as Record<string, unknown>) ?? {},
    metadata: (r["metadata"] as Record<string, unknown>) ?? {},
    version: Number(r["version"] ?? 1),
    occurredAt: (r["occurred_at"] as string) ?? null,
    updatedAt: (r["updated_at"] as string) ?? null,
  };
}

export type CanonicalScope = {
  branchId?: string | null;
  from?: string | null;
  to?: string | null;
  module?: string | null;
  financialState?: string | null;
};

/** Read model: the canonical register, scoped by the caller's permissions. */
export function useCanonicalRegister(scope: CanonicalScope = {}, enabled = true) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [
      "canonical-state",
      organizationId,
      scope.branchId ?? "all",
      scope.from ?? null,
      scope.to ?? null,
      scope.module ?? "all",
      scope.financialState ?? "all",
    ],
    enabled: enabled && Boolean(organizationId),
    queryFn: async (): Promise<CanonicalStateRow[]> => {
      const { data, error } = await rpc("neo_canonical_state_register", {
        _branch: scope.branchId ?? null,
        _from: scope.from ?? null,
        _to: scope.to ?? null,
        _module: scope.module ?? null,
        _financial: scope.financialState ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? []).map(mapRow);
    },
  });
}

/** The canonical state of one record, or null when it has never been recorded. */
export function useCanonicalState(kind: EntityKind, sourceId: string | null | undefined) {
  const module = workflowFor(kind).module;
  const register = useCanonicalRegister({ module }, Boolean(sourceId));
  const row = register.data?.find((r) => r.sourceId === sourceId) ?? null;
  return { ...register, row };
}

export type TransitionInput = Omit<CanonicalFacts, "state"> & {
  /** State the record is believed to be in; used to validate the move. */
  from: string;
  /** State being claimed. */
  to: string;
  financialState?: string | null;
  journalId?: string | null;
  receiptId?: string | null;
  occurredAt?: string | null;
};

/**
 * Persist a state transition. Throws before touching the database when the
 * move is illegal or the record is not fully identified — a half-identified
 * transaction is worse than a rejected one, because nothing can trace it.
 */
export async function recordCanonicalTransition(input: TransitionInput): Promise<string> {
  const facts: Partial<CanonicalFacts> = { ...input, state: input.to };
  const missing = missingCanonicalFacts(facts);
  if (missing.length) {
    throw new Error(
      `${workflowFor(input.kind).label}: transition rejected — missing ${missing.join(", ")}.`,
    );
  }
  assertTransition(input.kind, input.from, input.to);

  const to = normaliseState(input.to);
  const { data, error } = await rpc("neo_canonical_transaction_set", {
    _org: input.organizationId,
    _branch: input.branchId ?? null,
    _module: workflowFor(input.kind).module,
    _source: input.sourceId,
    _reference: input.reference ?? null,
    _operational: to,
    _financial: input.financialState ?? null,
    _amount: input.amount ?? 0,
    _currency: input.currency ?? "KES",
    _idempotency: input.idempotencyKey,
    _actor: input.actorId ?? null,
    _owner: ownerFor(input.kind, to),
    _next_action: nextActionFor(input.kind, to),
    _blocker: input.blocker ?? null,
    _journal: input.journalId ?? null,
    _receipt: input.receiptId ?? null,
    _downstream: input.downstream ?? {},
    _metadata: { ...(input.metadata ?? {}), entity_kind: input.kind, from_state: normaliseState(input.from) },
    _occurred: input.occurredAt ?? new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return String(data ?? "");
}

export function useRecordTransition() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: recordCanonicalTransition,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["canonical-state"] });
    },
  });
}
