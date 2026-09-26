/**
 * Courier dispatch simulator — sandbox only.
 *
 * This stands in for a courier service so the whole dispatch path can be
 * exercised before one is signed: NEØ sends the job, "the courier" answers back
 * on the callback address, and the order moves from that answer exactly as it
 * would from a real one. It sends nobody anywhere and costs nothing.
 *
 * Point a sandbox Courier Dispatch connection's request address at
 *   https://<this site>/api/public/delivery/simulator/courier
 * and dispatch an order. The outcome is decided by the order amount's cents so a
 * tester can ask for a specific answer on purpose:
 *
 *   .13 → failed      .01 → cancelled      .77 → left waiting (no answer)
 *   anything else     → accepted, then collected and delivered a moment later
 *
 * It refuses outright to answer a production request, and it will only call back
 * to this same site, so it can never be aimed at somebody else's system.
 */
import { createFileRoute } from "@tanstack/react-router";

type DispatchRequest = {
  job_id?: string;
  order_number?: string;
  amount?: number;
  callback_url?: string;
  environment?: string;
};

function decide(amount: number): "failed" | "cancelled" | "pending" | "accepted" {
  const cents = Math.round((amount - Math.floor(amount)) * 100);
  if (cents === 13) return "failed";
  if (cents === 1) return "cancelled";
  if (cents === 77) return "pending";
  return "accepted";
}

function sameSite(callbackUrl: string, request: Request): boolean {
  try {
    const target = new URL(callbackUrl);
    if (target.protocol !== "https:" && target.hostname !== "localhost") return false;
    return target.host === new URL(request.url).host;
  } catch {
    return false;
  }
}

async function answer(callbackUrl: string, status: string, reference: string) {
  await fetch(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, reference, message: `Simulated courier: ${status}` }),
  });
}

export const Route = createFileRoute("/api/public/delivery/simulator/courier")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: DispatchRequest;
        try {
          body = (await request.json()) as DispatchRequest;
        } catch {
          return Response.json({ status: "error", message: "Unreadable request" }, { status: 400 });
        }

        if (body.environment !== "sandbox") {
          return Response.json(
            {
              status: "error",
              message: "The simulator only answers sandbox requests. Connect a real courier for production.",
            },
            { status: 403 },
          );
        }

        const amount = Number(body.amount ?? 0);
        const outcome = decide(Number.isFinite(amount) ? amount : 0);
        const reference = `SIM-${(body.order_number ?? body.job_id ?? "").slice(-8).toUpperCase() || Math.random().toString(36).slice(2, 10).toUpperCase()}`;

        if (outcome === "pending") {
          return Response.json({
            status: "pending",
            reference,
            message: "Simulated courier has the job and has not answered yet.",
          });
        }

        // Answer on the callback address the way a real courier does, so the
        // webhook path is the one being proven, not a shortcut.
        if (body.callback_url && sameSite(body.callback_url, request)) {
          const url = body.callback_url;
          try {
            if (outcome === "accepted") {
              await answer(url, "accepted", reference);
              await answer(url, "picked_up", reference);
              await answer(url, "delivered", reference);
            } else {
              await answer(url, outcome, reference);
            }
          } catch {
            // The board still hears the immediate answer below; nothing is claimed delivered here.
          }
        }

        return Response.json({
          status: outcome === "accepted" ? "delivered" : outcome,
          reference,
          message: `Simulated courier: ${outcome}`,
        });
      },
    },
  },
});
