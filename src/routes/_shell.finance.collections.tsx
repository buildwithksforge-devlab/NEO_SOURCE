/**
 * Pending Collections has been folded into the canonical cashier queue.
 *
 * Awaiting collection and awaiting posting are two stages of one conveyor, not
 * two registers — keeping them on separate routes let their counts disagree.
 * This route now redirects so there is a single source of truth.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_shell/finance/collections")({
  beforeLoad: () => {
    throw redirect({ to: "/finance/queue", search: { stage: "collect" } });
  },
});
