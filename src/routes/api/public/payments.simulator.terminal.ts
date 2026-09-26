/**
 * Card terminal / QR simulator — sandbox only.
 *
 * This stands in for a processor so the whole collection path can be exercised
 * before a real acquirer is signed: the till sends a request, "the terminal"
 * answers back on the callback address, and NEØ settles the bill from that
 * answer exactly as it would from a real one. It moves no money and reaches no
 * bank.
 *
 * Point a sandbox card-terminal or QR connection's request address at
 *   https://<this site>/api/public/payments/simulator/terminal
 * and take a payment. The outcome is decided by the cents so a tester can ask
 * for a specific answer on purpose:
 *
 *   .13 → declined      .01 → cancelled      .77 → left pending (no answer)
 *   anything else       → approved
 *
 * It refuses outright to answer a production request, and it will only call
 * back to this same site, so it can never be aimed at somebody else's system.
 */
import { createFileRoute } from "@tanstack/react-router";

type IntentRequest = {
  intent_id?: string;
  amount?: number;
  currency?: string;
  reference?: string;
  method?: string;
  callback_url?: string;
  environment?: string;
};

function decide(amount: number): "approved" | "declined" | "cancelled" | "pending" {
  const cents = Math.round((amount - Math.floor(amount)) * 100);
  if (cents === 13) return "declined";
  if (cents === 1) return "cancelled";
  if (cents === 77) return "pending";
  return "approved";
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

export const Route = createFileRoute("/api/public/payments/simulator/terminal")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: IntentRequest;
        try {
          body = (await request.json()) as IntentRequest;
        } catch {
          return Response.json({ status: "error", message: "Unreadable request" }, { status: 400 });
        }

        if (body.environment !== "sandbox") {
          return Response.json(
            {
              status: "error",
              message: "The simulator only answers sandbox requests. Connect a real processor for production.",
            },
            { status: 403 },
          );
        }

        const amount = Number(body.amount ?? 0);
        if (!Number.isFinite(amount) || amount <= 0) {
          return Response.json({ status: "error", message: "An amount is required" }, { status: 400 });
        }

        const outcome = decide(amount);
        const providerReference = `SIM-${(body.reference ?? body.intent_id ?? "").slice(-8).toUpperCase() || Math.random().toString(36).slice(2, 10).toUpperCase()}`;

        if (outcome === "pending") {
          return Response.json({
            status: "pending",
            reference: providerReference,
            message: "Simulated terminal is waiting for the customer and will not answer.",
          });
        }

        // Answer the way a real terminal does: on the callback address, so the
        // webhook path is the one being proven, not a shortcut.
        if (body.callback_url && sameSite(body.callback_url, request)) {
          try {
            await fetch(body.callback_url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                status: outcome,
                reference: providerReference,
                message: `Simulated card terminal: ${outcome}`,
              }),
            });
          } catch {
            // The till still hears the outcome below; nothing is claimed settled here.
          }
        }

        // A QR provider never answers on the spot: it hands back a code to show
        // the guest and confirms later on the callback. The till therefore stays
        // pending until that callback lands, exactly as with a real provider.
        if ((body.method ?? "").toLowerCase() === "qr") {
          return Response.json({
            status: "pending",
            reference: providerReference,
            qr_payload: `neo://sandbox-qr/${providerReference}?amount=${amount.toFixed(2)}&currency=${body.currency ?? "KES"}`,
            message: "Simulated QR issued; the confirmation arrives on the callback.",
          });
        }

        return Response.json({
          status: outcome,
          reference: providerReference,
          message: `Simulated card terminal: ${outcome}`,
        });
      },
    },
  },
});
