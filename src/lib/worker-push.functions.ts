import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Public VAPID key is safe to expose; the private key remains server-only. */
export const getWorkerPushConfiguration = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => ({
    publicKey: process.env["WEB_PUSH_VAPID_PUBLIC_KEY"] || "",
    available: Boolean(
      process.env["NEO_PUSH_DISPATCH_ENABLED"] === "true" &&
      process.env["WEB_PUSH_VAPID_PUBLIC_KEY"] &&
      process.env["WEB_PUSH_VAPID_PRIVATE_KEY"] &&
      process.env["WEB_PUSH_VAPID_SUBJECT"] &&
      process.env["NEO_PUSH_DISPATCH_TOKEN"],
    ),
  }));
