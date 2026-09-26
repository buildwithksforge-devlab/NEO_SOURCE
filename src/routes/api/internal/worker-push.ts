import { createFileRoute } from "@tanstack/react-router";
import { trustedRpc } from "@/lib/rpc-guard";

async function tokenMatches(supplied: string, expected: string): Promise<boolean> {
  const encode = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode.encode(supplied)),
    crypto.subtle.digest("SHA-256", encode.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return difference === 0;
}

type ClaimedDelivery = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
  notification_id: string;
};

export const Route = createFileRoute("/api/internal/worker-push")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["NEO_PUSH_DISPATCH_TOKEN"] || "";
        const publicKey = process.env["WEB_PUSH_VAPID_PUBLIC_KEY"] || "";
        const privateKey = process.env["WEB_PUSH_VAPID_PRIVATE_KEY"] || "";
        const subject = process.env["WEB_PUSH_VAPID_SUBJECT"] || "";
        if (process.env["NEO_PUSH_DISPATCH_ENABLED"] !== "true" ||
            secret.length < 32 || !publicKey || !privateKey || !subject) {
          return new Response("Phone alert dispatch unavailable", { status: 503 });
        }
        const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        if (!(await tokenMatches(provided, secret))) return new Response("Unauthorized", { status: 401 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as unknown as {
          rpc: (name: string, args: Record<string, number>) => Promise<{ data: ClaimedDelivery[] | null; error: { message: string } | null }>;
          from: (name: string) => any;
        };
        const { data, error } = await trustedRpc<ClaimedDelivery[]>(admin, "neo_claim_worker_push", { _limit: 25 });
        if (error) return new Response("Dispatch claim failed", { status: 500 });
        const webpush = await import("web-push");
        webpush.setVapidDetails(subject, publicKey, privateKey);

        let accepted = 0;
        let retried = 0;
        let failed = 0;
        for (const delivery of data ?? []) {
          try {
            // The notification ID only groups duplicate device alerts; no tenant
            // or guest detail is delivered to the lock screen.
            const response = await webpush.sendNotification({
              endpoint: delivery.endpoint,
              keys: { p256dh: delivery.p256dh, auth: delivery.auth_key },
            }, JSON.stringify({ notificationId: delivery.notification_id }), { TTL: 3600, timeout: 10000 });
            if (response.statusCode < 200 || response.statusCode >= 300) throw new Error("Push service did not accept delivery");
            const updated = await admin.from("worker_push_deliveries").update({
              status: "accepted", accepted_at: new Date().toISOString(), locked_until: null, failure_code: null,
            }).eq("id", delivery.id).eq("status", "sending");
            if (updated.error) throw updated.error;
            accepted++;
          } catch (err) {
            const status = typeof err === "object" && err && "statusCode" in err ? Number(err.statusCode) : 0;
            const gone = status === 404 || status === 410;
            const permanent = gone || (status >= 400 && status < 500 && status !== 429);
            const { data: row } = await admin.from("worker_push_deliveries")
              .select("attempts").eq("id", delivery.id).maybeSingle();
            const attempts = Number(row?.attempts ?? 1);
            const exhausted = attempts >= 5;
            const updated = await admin.from("worker_push_deliveries").update({
              status: permanent || exhausted ? "failed" : "queued",
              locked_until: null,
              failure_code: status ? `push_${status}` : "push_transport_error",
              next_attempt_at: new Date(Date.now() + Math.min(30, 2 ** attempts) * 60_000).toISOString(),
            }).eq("id", delivery.id).eq("status", "sending");
            if (updated.error) return new Response("Dispatch state write failed", { status: 500 });
            if (permanent || exhausted) failed++;
            else retried++;
            if (gone) {
              await admin.from("worker_push_subscriptions").delete().eq("endpoint", delivery.endpoint);
            }
          }
        }
        return Response.json({ claimed: data?.length ?? 0, accepted, retried, failed });
      },
    },
  },
});
