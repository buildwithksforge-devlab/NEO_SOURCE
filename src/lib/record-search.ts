/**
 * Global record search — the data half of the Cmd/Ctrl+K palette.
 *
 * Three rules hold this together:
 *
 *   1. A record source is only queried when the signed-in user may open the
 *      page that record lives on. The palette never becomes a side channel
 *      into a module the sidebar hides.
 *   2. Every query is anchored to the caller's organisation, and to the
 *      active property whenever the table carries a branch. Searching does
 *      not widen scope.
 *   3. Results are read-only pointers. Selecting one navigates; it never
 *      mutates, and it never invents a record that the destination page
 *      would refuse to show.
 *
 * The planning and ranking halves are pure so the contract can be tested
 * without a database.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ilikeOrFilter } from "@/lib/or-filter";

export type RecordKind =
  | "guest"
  | "reservation"
  | "folio"
  | "room"
  | "order"
  | "supplier"
  | "invoice";

export type RecordHit = {
  kind: RecordKind;
  /** Group heading shown in the palette. */
  group: string;
  /** Primary line — the human name of the record. */
  title: string;
  /** Secondary line — the identifier or context that disambiguates it. */
  subtitle: string;
  /** Destination route. Always a page the user is allowed to open. */
  to: string;
  /** Ranking aid; lower sorts first. */
  weight: number;
};

type Row = Record<string, unknown>;

export type RecordSource = {
  kind: RecordKind;
  group: string;
  /** Page that owns the record; drives both the permission check and the link. */
  page: string;
  table: string;
  columns: string;
  /** Columns matched with a case-insensitive contains search. */
  search: string[];
  /** Whether the table carries branch_id and must be property-scoped. */
  branchScoped: boolean;
  weight: number;
  map: (row: Row) => { title: string; subtitle: string; to: string } | null;
};

const text = (row: Row, key: string): string => {
  const v = row[key];
  return typeof v === "string" ? v : v == null ? "" : String(v);
};

export const RECORD_SOURCES: RecordSource[] = [
  {
    kind: "guest",
    group: "Guests",
    page: "/guests",
    table: "customers",
    columns: "id, full_name, customer_number, phone, email, company",
    search: ["full_name", "customer_number", "phone", "email", "company"],
    branchScoped: false,
    weight: 1,
    map: (row) => {
      const name = text(row, "full_name");
      if (!name) return null;
      return {
        title: name,
        subtitle: [text(row, "customer_number"), text(row, "phone"), text(row, "company")]
          .filter(Boolean)
          .join(" · "),
        to: "/guests",
      };
    },
  },
  {
    kind: "reservation",
    group: "Reservations",
    page: "/pms/reservations",
    table: "reservations",
    columns: "id, confirmation_number, arrival_date, departure_date, status, external_reference",
    search: ["confirmation_number", "external_reference"],
    branchScoped: true,
    weight: 2,
    map: (row) => {
      const ref = text(row, "confirmation_number");
      const id = text(row, "id");
      if (!id) return null;
      return {
        title: ref || "Reservation",
        subtitle: [text(row, "arrival_date"), text(row, "departure_date")]
          .filter(Boolean)
          .join(" → "),
        to: `/pms/reservations/${id}`,
      };
    },
  },
  {
    kind: "folio",
    group: "Folios",
    page: "/pms/folios",
    table: "folios",
    columns: "id, folio_number, status, balance, currency",
    search: ["folio_number"],
    branchScoped: true,
    weight: 2,
    map: (row) => {
      const id = text(row, "id");
      if (!id) return null;
      return {
        title: text(row, "folio_number") || "Folio",
        subtitle: text(row, "status"),
        to: `/pms/folios/${id}`,
      };
    },
  },
  {
    kind: "room",
    group: "Rooms",
    page: "/pms/rooms",
    table: "rooms",
    columns: "id, room_number, occupancy_status, housekeeping_status, floor",
    search: ["room_number"],
    branchScoped: true,
    weight: 3,
    map: (row) => {
      const number = text(row, "room_number");
      if (!number) return null;
      return {
        title: `Room ${number}`,
        subtitle: [text(row, "occupancy_status"), text(row, "housekeeping_status")]
          .filter(Boolean)
          .join(" · "),
        to: "/pms/rooms",
      };
    },
  },
  {
    kind: "order",
    group: "POS orders",
    page: "/pos/orders",
    table: "pos_orders",
    columns: "id, order_number, status, order_type, guest_name, grand_total, currency",
    search: ["order_number", "guest_name"],
    branchScoped: true,
    weight: 3,
    map: (row) => {
      const id = text(row, "id");
      if (!id) return null;
      return {
        title: text(row, "order_number") || "Order",
        subtitle: [text(row, "order_type"), text(row, "status"), text(row, "guest_name")]
          .filter(Boolean)
          .join(" · "),
        to: `/pos/orders/${id}`,
      };
    },
  },
  {
    kind: "supplier",
    group: "Suppliers",
    page: "/admin/suppliers",
    table: "suppliers",
    columns: "id, name, code, phone, email",
    search: ["name", "code", "phone", "email"],
    branchScoped: false,
    weight: 4,
    map: (row) => {
      const name = text(row, "name");
      if (!name) return null;
      return {
        title: name,
        subtitle: [text(row, "code"), text(row, "phone")].filter(Boolean).join(" · "),
        to: "/admin/suppliers",
      };
    },
  },
  {
    kind: "invoice",
    group: "Supplier invoices",
    page: "/finance/ap-matching",
    table: "supplier_invoices",
    columns: "id, invoice_number, status, match_status, amount, invoice_date",
    search: ["invoice_number"],
    branchScoped: true,
    weight: 4,
    map: (row) => {
      const number = text(row, "invoice_number");
      if (!number) return null;
      return {
        title: number,
        subtitle: [text(row, "match_status"), text(row, "status")].filter(Boolean).join(" · "),
        to: "/finance/ap-matching",
      };
    },
  },
];

/** A search needs at least two characters before it is worth a round trip. */
export function isSearchable(query: string): boolean {
  return query.trim().length >= 2;
}

/**
 * The sources this user may search. Permission is decided by the page the
 * record opens on — exactly the check the sidebar and the route guard use.
 */
export function plannedSources(
  canSeePage: (path: string) => boolean,
  query: string,
): RecordSource[] {
  if (!isSearchable(query)) return [];
  return RECORD_SOURCES.filter((source) => canSeePage(source.page));
}

/**
 * Exact identifier matches sort above partial name matches, then source
 * weight, then alphabetically — so typing a folio number lands on the folio.
 */
export function rankHits(hits: RecordHit[], query: string): RecordHit[] {
  const q = query.trim().toLowerCase();
  const score = (hit: RecordHit) => {
    const title = hit.title.toLowerCase();
    const subtitle = hit.subtitle.toLowerCase();
    if (title === q) return 0;
    if (title.startsWith(q)) return 1;
    if (title.includes(q)) return 2;
    if (subtitle.includes(q)) return 3;
    return 4;
  };
  return [...hits].sort(
    (a, b) =>
      score(a) - score(b) || a.weight - b.weight || a.title.localeCompare(b.title),
  );
}

function orFilter(source: RecordSource, query: string): string {
  // PostgREST `or` needs commas escaped out of the pattern; a search term is
  // free text typed by an operator, so it is sanitised rather than trusted.
  return ilikeOrFilter(source.search, query);
}

export type RecordSearchScope = {
  organizationId: string | null;
  branchId: string | null;
  canSeePage: (path: string) => boolean;
};

/**
 * Runs the permitted searches in parallel. A source that errors is skipped —
 * one denied table must never blank the whole palette.
 */
export async function searchRecords(
  client: SupabaseClient,
  scope: RecordSearchScope,
  query: string,
  limitPerSource = 5,
): Promise<RecordHit[]> {
  if (!scope.organizationId) return [];
  const sources = plannedSources(scope.canSeePage, query);
  if (!sources.length) return [];

  const settled = await Promise.all(
    sources.map(async (source) => {
      try {
        let builder = client
          .from(source.table)
          .select(source.columns)
          .eq("organization_id", scope.organizationId)
          .or(orFilter(source, query));
        if (source.branchScoped && scope.branchId) {
          builder = builder.eq("branch_id", scope.branchId);
        }
        const { data, error } = await builder.limit(limitPerSource);
        if (error || !data) return [];
        return (data as unknown as Row[]).flatMap((row) => {
          const mapped = source.map(row);
          if (!mapped) return [];
          return [
            {
              kind: source.kind,
              group: source.group,
              weight: source.weight,
              ...mapped,
            } satisfies RecordHit,
          ];
        });
      } catch {
        return [];
      }
    }),
  );

  return rankHits(settled.flat(), query);
}
