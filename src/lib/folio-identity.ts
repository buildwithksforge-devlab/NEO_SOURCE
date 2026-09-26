/**
 * Canonical folio identity.
 *
 * A folio permanently knows who and what it belongs to. Guest statements,
 * refunds, account ledgers and the folio detail page all read the identity
 * through this one module, so no surface can invent, collapse or lose the
 * facts that receivables, CRM, disputes, tax documents and audit depend on.
 *
 * This module derives identity only — it never computes or restates money.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { guardedRpc } from "@/lib/rpc-guard";

/** Human label for a stored enum-style word, without restating its meaning. */
const titleWord = (value: string) =>
  value.replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

import { useBranchScope } from "@/lib/branches";
import { useFolio } from "@/lib/frontdesk-ops";

export type FolioIdentity = {
  folioId: string;
  folioNumber: string;
  folioType: string;
  status: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  customerId: string | null;
  companyName: string;
  companyId: string | null;
  reservationId: string | null;
  confirmationNumber: string;
  roomId: string | null;
  roomNumber: string;
  branchId: string | null;
  propertyName: string;
  arrival: string | null;
  departure: string | null;
  stay: string;
  billingInstructions: string;
  currency: string;
  openedAt: string | null;
  closedAt: string | null;
};

const DASH = "—";

/** Derive the canonical identity from a folio row joined to its relations. */
export function deriveFolioIdentity(
  row: Record<string, unknown> | null | undefined,
  propertyName?: string | null,
): FolioIdentity | null {
  if (!row) return null;
  const rec = row as Record<string, any>;
  const reservation = (rec["reservations"] ?? null) as Record<string, any> | null;
  const customer = (rec["customers"] ?? null) as Record<string, any> | null;
  const corporate = (rec["corporate_accounts"] ?? null) as Record<string, any> | null;
  const group = (rec["group_bookings"] ?? null) as Record<string, any> | null;
  const room = (reservation?.["rooms"] ?? null) as Record<string, any> | null;

  const arrival = (reservation?.["arrival_date"] as string | undefined) ?? null;
  const departure = (reservation?.["departure_date"] as string | undefined) ?? null;

  return {
    folioId: String(rec["id"] ?? ""),
    folioNumber: String(rec["folio_number"] ?? DASH),
    folioType: String(rec["folio_type"] ?? ""),
    status: String(rec["status"] ?? ""),
    guestName: (customer?.["full_name"] as string | undefined) || DASH,
    guestEmail: (customer?.["email"] as string | undefined) || "",
    guestPhone: (customer?.["phone"] as string | undefined) || "",
    customerId: (rec["customer_id"] as string | undefined) ?? null,
    companyName:
      (corporate?.["legal_name"] as string | undefined) ||
      (group?.["name"] as string | undefined) ||
      DASH,
    companyId:
      (rec["corporate_account_id"] as string | undefined) ??
      (rec["group_booking_id"] as string | undefined) ??
      null,
    reservationId: (reservation?.["id"] as string | undefined) ?? null,
    confirmationNumber: (reservation?.["confirmation_number"] as string | undefined) || DASH,
    roomId: (room?.["id"] as string | undefined) ?? null,
    roomNumber: (room?.["room_number"] as string | undefined) || DASH,
    branchId: (rec["branch_id"] as string | undefined) ?? null,
    propertyName: propertyName || DASH,
    arrival,
    departure,
    stay: arrival || departure ? `${arrival ?? DASH} → ${departure ?? DASH}` : DASH,
    billingInstructions: (rec["billing_instructions"] as string | undefined) || DASH,
    currency: (rec["currency"] as string | undefined) ?? "KES",
    openedAt: (rec["opened_at"] as string | undefined) ?? null,
    closedAt: (rec["closed_at"] as string | undefined) ?? null,
  };
}

/** Identity for a folio id, resolved from the canonical folio record. */
export function useFolioIdentity(folioId: string | null | undefined) {
  const folio = useFolio(folioId ?? "");
  const { branches } = useBranchScope();
  const row = folio.data as Record<string, unknown> | null | undefined;
  const branchId = (row as Record<string, any> | null | undefined)?.["branch_id"] as
    | string
    | undefined;
  const propertyName = branches.find((b) => b.id === branchId)?.name ?? null;
  return {
    identity: deriveFolioIdentity(row, propertyName),
    isLoading: folio.isLoading,
    error: folio.error,
  };
}

export type FolioTraceEvent = {
  id: string;
  at: string;
  kind: "reservation" | "room" | "housekeeping" | "notification" | "posting" | "payment";
  title: string;
  detail: string;
};

/**
 * Every operational event, task and notification that touches this folio's
 * reservation and room, in one chronology. Nothing is inferred: each entry is
 * a stored row from the module that raised it.
 */
export function useFolioTrace(identity: FolioIdentity | null) {
  const { organizationId } = useAuth();
  const folioId = identity?.folioId ?? null;
  const reservationId = identity?.reservationId ?? null;
  const roomId = identity?.roomId ?? null;

  return useQuery({
    queryKey: ["folio-trace", organizationId, folioId, reservationId, roomId],
    enabled: Boolean(organizationId && folioId),
    queryFn: async (): Promise<FolioTraceEvent[]> => {
      const events: FolioTraceEvent[] = [];

      if (reservationId) {
        const { data } = await supabase
          .from("reservation_history")
          .select("id, action, field, previous_value, new_value, reason, created_at")
          .eq("reservation_id", reservationId)
          .order("created_at", { ascending: false })
          .limit(50);
        for (const r of data ?? []) {
          const row = r as Record<string, any>;
          events.push({
            id: `res-${row["id"]}`,
            at: String(row["created_at"]),
            kind: "reservation",
            title: String(row["action"] ?? "Reservation event").replace(/[._-]/g, " "),
            detail: [
              row["field"],
              row["previous_value"] || row["new_value"]
                ? `${row["previous_value"] ?? "—"} → ${row["new_value"] ?? "—"}`
                : null,
              row["reason"],
            ]
              .filter(Boolean)
              .join(" · "),
          });
        }
      }

      if (roomId) {
        const [{ data: history }, { data: jobs }] = await Promise.all([
          supabase
            .from("room_status_history")
            .select("id, field, previous_value, new_value, reason, created_at")
            .eq("room_id", roomId)
            .order("created_at", { ascending: false })
            .limit(50),
          supabase
            .from("housekeeping_jobs")
            .select(
              "id, job_number, job_type, status, inspection_status, priority, created_at, completed_at",
            )
            .eq("room_id", roomId)
            .order("created_at", { ascending: false })
            .limit(50),
        ]);
        for (const r of history ?? []) {
          const row = r as Record<string, any>;
          events.push({
            id: `room-${row["id"]}`,
            at: String(row["created_at"]),
            kind: "room",
            title: `Room ${String(row["field"] ?? "status").replace(/_/g, " ")}`,
            detail: [
              `${row["previous_value"] ?? "—"} → ${row["new_value"] ?? "—"}`,
              row["reason"],
            ]
              .filter(Boolean)
              .join(" · "),
          });
        }
        for (const r of jobs ?? []) {
          const row = r as Record<string, any>;
          events.push({
            id: `hk-${row["id"]}`,
            at: String(row["completed_at"] ?? row["created_at"]),
            kind: "housekeeping",
            title: `${String(row["job_type"] ?? "Housekeeping task").replace(/_/g, " ")} ${
              row["job_number"] ? `· ${row["job_number"]}` : ""
            }`.trim(),
            detail: [row["status"], row["inspection_status"], row["priority"]]
              .filter(Boolean)
              .join(" · "),
          });
        }
      }

      const ids = [folioId, reservationId].filter(Boolean) as string[];
      if (ids.length) {
        const { data } = await supabase
          .from("notifications")
          .select("id, title, body, category, event_type, status, created_at")
          .in("source_record_id", ids)
          .order("created_at", { ascending: false })
          .limit(50);
        for (const r of data ?? []) {
          const row = r as Record<string, any>;
          events.push({
            id: `note-${row["id"]}`,
            at: String(row["created_at"]),
            kind: "notification",
            title: String(row["title"] ?? "Notification"),
            detail: [row["event_type"], row["status"], row["body"]].filter(Boolean).join(" · "),
          });
        }
      }

      const { data: lines } = await supabase
        .from("folio_lines")
        .select("id, description, source_module, status, posting_date, created_at")
        .eq("folio_id", folioId as string)
        .order("created_at", { ascending: false })
        .limit(50);
      for (const r of lines ?? []) {
        const row = r as Record<string, any>;
        events.push({
          id: `line-${row["id"]}`,
          at: String(row["created_at"] ?? row["posting_date"]),
          kind: "posting",
          title: String(row["description"] ?? "Folio posting"),
          detail: [row["source_module"], row["status"]].filter(Boolean).join(" · "),
        });
      }

      // Settlement belongs in the same chronology as the charges it settles.
      // The actor is shown only when the stored record captured one — never
      // invented — and the ledger is only claimed when a posted journal proves
      // it.
      const { data: traceProof, error: traceError } = await guardedRpc(
        supabase,
        "neo_folio_payment_trace",
        { _folio: folioId },
      );
      if (traceError) throw new Error(traceError.message);
      const receipts = ((traceProof as Record<string, any> | null)?.["payments"] ?? []) as Array<
        Record<string, any>
      >;
      for (const trail of receipts) {
        const row = trail;
        const found = Boolean(trail?.["found"]);
        const consequence = ((found ? trail?.["financial_consequence"] : null) ?? []) as Array<
          Record<string, any>
        >;
        // The journal reference comes from the same proof-based routine, so a
        // cashier without ledger access still sees the settlement it produced.
        const journalNumber =
          found && trail?.["journal_status"] === "posted" && trail?.["journal_number"]
            ? String(trail["journal_number"])
            : null;

        const actorName = found
          ? (trail?.["captured_actor_name"] as string | null) ||
            ((trail?.["events"] ?? []) as Array<Record<string, any>>).find(
              (e) => e["actor_name"],
            )?.["actor_name"]
          : null;
        const consequenceText = consequence
          .map((l) => {
            const name = String(l["account_name"] ?? l["account_code"] ?? "").trim();
            const debit = Number(l["debit"] ?? 0);
            const credit = Number(l["credit"] ?? 0);
            const amount = (debit || credit).toLocaleString(undefined, {
              minimumFractionDigits: 2,
            });
            return `${debit ? "Dr" : "Cr"} ${name} ${row["currency"] ?? "KES"} ${amount}`;
          })
          .join(" · ");
        events.push({
          id: `pay-${row["payment_id"]}`,
          at: String(row["recorded_at"] ?? ""),
          kind: "payment",
          title: `Receipt ${String(row["reference"] ?? "").trim() || "—"} · ${Number(
            trail["amount"] ?? 0,
          ).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${String(
             trail["currency"] ?? identity?.currency ?? "KES",
          )}`,
          detail: [
            trail["method"] ? titleWord(String(trail["method"])) : null,
            actorName ? `Actor ${actorName}` : "Actor not captured",
            journalNumber ? `In the ledger · ${journalNumber}` : String(row["status"] ?? ""),
            consequenceText || null,
          ]
            .filter(Boolean)
            .join(" · "),
        });
      }


      return events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    },
  });
}
