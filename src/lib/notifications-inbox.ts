import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { reportQueryError } from "@/lib/query-telemetry";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useVisibility } from "@/lib/visibility";
import type { NotificationSubject, VisibilityContract } from "@/lib/visibility-contract";

/**
 * One notification inbox for the whole app.
 *
 * The unread badge and the notifications list must never disagree: both read
 * this single query and apply the same visibility contract, so a count can
 * never include a notice the reader cannot open, and the list can never hide
 * one the badge counted.
 */
export type InboxNotification = {
  id: string;
  category: string;
  title: string;
  body: string;
  link: string | null;
  priority: string;
  read_at: string | null;
  created_at: string;
  action_required: boolean | null;
  status: string | null;
  acted_at: string | null;
  source_module: string | null;
  source_record_id: string | null;
  event_type: string | null;
  user_id: string | null;
  branch_id: string | null;
  department_id: string | null;
  station_id: string | null;
};

/** Audience is derived from the narrowest addressing column that is set. */
export function notificationSubject(n: InboxNotification): NotificationSubject {
  if (n.user_id) return { audience: "personal", userId: n.user_id };
  if (n.station_id) return { audience: "station", stationId: n.station_id };
  if (n.department_id) return { audience: "department", departmentId: n.department_id };
  if (n.branch_id) return { audience: "property", branchId: n.branch_id };
  return { audience: "organization" };
}

export function visibleNotifications(
  rows: InboxNotification[],
  visibility: VisibilityContract,
): InboxNotification[] {
  return rows.filter((n) => visibility.receivesNotification(notificationSubject(n)));
}

const INBOX_LIMIT = 150;

/**
 * Only the columns the inbox renders. A `select *` on this table is one of the
 * heaviest reads in the workspace because every row is checked by the row
 * level security scope function, so the read stays narrow and bounded.
 */
const INBOX_COLUMNS =
  "id, category, title, body, link, priority, read_at, created_at, action_required, status, acted_at, source_module, source_record_id, event_type, user_id, branch_id, department_id, station_id";

export function useNotificationInbox() {
  const { organizationId } = useAuth();
  const { applyTo, filterKey } = useActivePropertyFilter();
  const visibility = useVisibility();

  const query = useQuery({
    // One shared cache entry: the badge and the page never refetch differently.
    queryKey: ["notifications-unread", organizationId, filterKey],
    enabled: Boolean(organizationId),
    refetchInterval: 120_000,
    staleTime: 60_000,
    queryFn: async () => {
      // Anchor the read to the workspace so the organisation/date index is used
      // instead of a scan filtered only by row level security, then apply the
      // shared property filter directly to that query.
      const { data, error } = await applyTo(
        supabase.from("notifications").select(INBOX_COLUMNS).eq("organization_id", organizationId ?? ""),
        "notifications",
      )
        .order("created_at", { ascending: false })
        .limit(INBOX_LIMIT);
      if (error) {
        reportQueryError("notifications.unread-count", error);
        throw error;
      }
      return (data ?? []) as unknown as InboxNotification[];
    },
  });


  const items = useMemo(
    () => visibleNotifications(Array.isArray(query.data) ? query.data : [], visibility),
    [query.data, visibility],
  );
  const unread = useMemo(() => items.filter((n) => !n.read_at), [items]);

  return { query, items, unread, unreadCount: unread.length };
}
